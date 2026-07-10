import io
import json
import os
import shutil
import tempfile
import zipfile

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.parsers import MultiPartParser
from django.db.models import Sum, F, DecimalField, Count, Value, Q
from django.db.models.functions import Coalesce
from django.utils import timezone
from django.http import HttpResponse
from django.conf import settings
from django.core.management import call_command
from datetime import timedelta

from .models import CustomUser, Product, ProductVariant, MagasinProfile, Sale, EmployerProfile, AdminProfile, Movement, ChatMessage, Notification
from .serializers import RegisterSerializer, ProductSerializer, SaleSerializer, MovementSerializer, NotificationSerializer, MagasinProfileSerializer, ChatMessageSerializer
from .permissions import IsAdmin
from rest_framework_simplejwt.views import TokenViewBase
from .authentication import CustomTokenObtainPairSerializer
from .models import Notification


def _variant_label(size, color):
    """Build a human-readable label ('Taille/Couleur') for a product variant."""
    parts = [str(p).strip() for p in [size, color] if p and str(p).strip()]
    return '/'.join(parts) if parts else None


def _auto_generate_qr(product):
    """Generate and save a QR code image for a product if it has none."""
    try:
        import qrcode
        from django.core.files.base import ContentFile
        qr_source = product.reference or product.name
        qr_img = qrcode.make(qr_source)
        buf = io.BytesIO()
        qr_img.save(buf, format='PNG')
        buf.seek(0)
        fname = f"qr-{qr_source.replace(' ', '-').replace('/', '-')}.png"
        product.qr_code.save(fname, ContentFile(buf.read()), save=True)
    except Exception:
        pass


def get_user_admin(user):
    if not user or user.is_anonymous:
        return None
    if user.role == "admin":
        return user
    elif user.role == "magasin":
        try:
            return user.magasin_profile.admin
        except Exception:
            return None
    elif user.role == "employer":
        try:
            ep = user.employer_profile
            if ep.admin:
                return ep.admin
            if ep.magasin:
                return ep.magasin.admin
        except Exception:
            return None
    return None


def get_company_magasins(user):
    """Magasins forming the 'company' a user belongs to.

    Unlike get_user_admin (which only resolves the single primary/owner admin),
    this also accounts for co-admins linked through MagasinProfile.admins (M2M),
    so admins added via AddAdminView are recognized as part of the same company.
    """
    if not user or user.is_anonymous:
        return MagasinProfile.objects.none()
    if user.role == "admin":
        return MagasinProfile.objects.filter(Q(admin=user) | Q(admins=user)).distinct()
    elif user.role == "magasin":
        try:
            return MagasinProfile.objects.filter(id=user.magasin_profile.id)
        except Exception:
            return MagasinProfile.objects.none()
    elif user.role == "employer":
        try:
            ep = user.employer_profile
            if ep.magasin:
                return MagasinProfile.objects.filter(id=ep.magasin.id)
        except Exception:
            pass
    return MagasinProfile.objects.none()


def get_company_id(user):
    """Stable identifier for a user's company, used to scope the general chat room.

    Based on the company's primary magasin owner (admin FK), so every co-admin,
    gérant and employer of the same magasins lands in the same room regardless
    of which admin is currently logged in.
    """
    magasin = get_company_magasins(user).order_by("id").first()
    return magasin.admin_id if magasin else None


def _sale_purchase_price(sale):
    purchase_price = sale.purchase_price
    if purchase_price is None or purchase_price == 0:
        product = sale.product
        purchase_price = getattr(product, "purchase_price", None) or getattr(product, "unit_price", 0) or 0
    return purchase_price


def _sale_totals(sales_qs):
    total_revenue = 0
    total_cost = 0
    total_profit = 0
    total_quantity = 0

    for sale in sales_qs.select_related("product"):
        quantity = sale.quantity or 0
        sale_price = sale.sale_price or 0
        purchase_price = _sale_purchase_price(sale)

        total_revenue += sale_price * quantity
        total_cost += purchase_price * quantity
        total_profit += (sale_price - purchase_price) * quantity
        total_quantity += quantity

    return total_revenue, total_cost, total_profit, total_quantity


def _unpaid_sales_metrics(sales_qs):
    unpaid_qs = sales_qs.filter(is_paid=False)
    unpaid_count = unpaid_qs.count()
    unpaid_value = unpaid_qs.aggregate(
        total=Coalesce(
            Sum(F('total_price') - Coalesce(F('payment_amount'), Value(0), output_field=DecimalField()), output_field=DecimalField()),
            Value(0),
            output_field=DecimalField()
        )
    )['total'] or 0
    return unpaid_count, unpaid_value

# =========================
# AUTH LOGIN
# =========================
class CustomLoginView(TokenViewBase):
    serializer_class = CustomTokenObtainPairSerializer

# =========================
# REGISTER
# =========================
class RegisterView(APIView):
    def post(self, request):
        serializer = RegisterSerializer(data=request.data)
        if serializer.is_valid():
            user = serializer.save()
            # If the new user is an admin, create a default "Stock Local" store linked to this admin.
            if user.role == "admin":
                from .models import MagasinProfile
                magasin = MagasinProfile.objects.create(
                    admin=user,
                    shop_name="Stock Local",
                    description="Magasin pour les stocks locaux",
                )
                magasin.admins.add(user)
            return Response({"message": "Inscription réussie", "id": user.id})
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

class AddAdminView(APIView):
    permission_classes = [IsAuthenticated, IsAdmin]

    def post(self, request):
        """Create a new admin user and associate with existing magasins of the requester."""
        serializer = RegisterSerializer(data=request.data)
        if serializer.is_valid():
            new_admin = serializer.save()
            # Ensure role is admin
            new_admin.role = "admin"
            new_admin.save()
            # Give the new admin the exact same access as the creator: every magasin
            # where the requester is the owner (admin FK) or a co-admin (admins M2M).
            current_admin = request.user
            magasins = MagasinProfile.objects.filter(Q(admin=current_admin) | Q(admins=current_admin)).distinct()
            for magasin in magasins:
                magasin.admins.add(new_admin)
            return Response({"message": "Admin ajouté", "id": new_admin.id}, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

# =========================
# APPROVE USER
# =========================
class ApproveUserView(APIView):
    permission_classes = [IsAuthenticated]
    def put(self, request, user_id):
        current_user = request.user
        if current_user.role not in ["admin", "magasin"]:
            return Response({"error": "Permission refusée"}, status=403)

        user_admin = get_user_admin(current_user)
        if not user_admin:
            return Response({"error": "Permission refusée : entreprise introuvable."}, status=403)

        if current_user.role == "magasin":
            try:
                magasin = current_user.magasin_profile
                is_member = CustomUser.objects.filter(
                    id=user_id,
                    role="employer",
                    employer_profile__magasin=magasin
                ).exists()
                if not is_member:
                    return Response({"error": "Permission refusée : cet employé n'appartient pas à votre magasin."}, status=403)
            except Exception:
                return Response({"error": "Magasin introuvable"}, status=404)
        else: # admin
            is_member = CustomUser.objects.filter(
                Q(id=user_id),
                Q(magasin_profile__admin=user_admin) | Q(employer_profile__admin=user_admin) | Q(employer_profile__magasin__admin=user_admin)
            ).exists()
            if not is_member:
                return Response({"error": "Permission refusée : cet utilisateur n'appartient pas à votre entreprise."}, status=403)

        try:
            user = CustomUser.objects.get(id=user_id)
            user.is_confirmed = True
            user.save()
            return Response({"message": "Utilisateur approuvé"})
        except CustomUser.DoesNotExist:
            return Response({"error": "Utilisateur introuvable"}, status=404)

# =========================
# MY PROFILE
# =========================
class Myprofile(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user
        data = {
            "id": user.id,
            "username": user.username,
            "email": user.email,
            "full_name": user.full_name,
            "phone": user.phone,
            "role": user.role,
            "is_confirmed": user.is_confirmed,
        }
        if user.role == "admin":
            try:
                p = user.admin_profile
                data["company_name"] = p.company_name
                data["logo"] = request.build_absolute_uri(p.logo.url) if p.logo else None
            except AdminProfile.DoesNotExist:
                pass
        elif user.role == "magasin":
            try:
                p = user.magasin_profile
                data["shop_name"] = p.shop_name
                data["magasin_id"] = p.id
                data["shop_logo"] = request.build_absolute_uri(p.shop_logo.url) if p.shop_logo else None
            except Exception:
                pass
        elif user.role == "employer":
            try:
                p = user.employer_profile
                data["position"] = p.position
                if p.magasin:
                    data["magasin_id"] = p.magasin.id
                    data["shop_name"] = p.magasin.shop_name
                    data["shop_logo"] = request.build_absolute_uri(p.magasin.shop_logo.url) if p.magasin.shop_logo else None
            except Exception:
                pass
        return Response(data)

    def patch(self, request):
        user = request.user
        full_name = request.data.get("full_name")
        phone = request.data.get("phone")
        if full_name:
            user.full_name = full_name
        if phone is not None:
            user.phone = phone
        user.save()

        if user.role == "admin":
            company_name = request.data.get("company_name")
            logo = request.data.get("logo")
            try:
                p = user.admin_profile
            except AdminProfile.DoesNotExist:
                p = AdminProfile(user=user)
            if company_name is not None:
                p.company_name = company_name
            if logo is not None and not isinstance(logo, str):
                p.logo = logo
            p.save()
        elif user.role == "magasin":
            shop_name = request.data.get("shop_name")
            shop_logo = request.data.get("shop_logo")
            try:
                p = user.magasin_profile
            except MagasinProfile.DoesNotExist:
                p = None
            if p:
                if shop_name is not None:
                    p.shop_name = shop_name
                if shop_logo is not None and not isinstance(shop_logo, str):
                    p.shop_logo = shop_logo
                p.save()

        return Response({"message": "Profil mis à jour"})

# =========================
# ROLE MANAGEMENT
# =========================
class RoleManagementView(APIView):
    permission_classes = [IsAuthenticated, IsAdmin]
    def put(self, request, user_id):
        current_user = request.user
        user_admin = get_user_admin(current_user)
        if not user_admin:
            return Response({"error": "Permission refusée : entreprise introuvable."}, status=403)

        # Verify user belongs to the same admin organization
        is_member = CustomUser.objects.filter(
            Q(id=user_id),
            Q(magasin_profile__admin=user_admin) | Q(employer_profile__admin=user_admin) | Q(employer_profile__magasin__admin=user_admin)
        ).exists()
        if not is_member:
            return Response({"error": "Permission refusée : cet utilisateur n'appartient pas à votre entreprise."}, status=403)

        try:
            user = CustomUser.objects.get(id=user_id)
            new_role = request.data.get("role")
            if new_role not in ["admin", "magasin", "employer"]:
                return Response({"error": "Rôle invalide. Les rôles valides sont: admin, magasin, employer"}, status=status.HTTP_400_BAD_REQUEST)
            old_role = user.role
            user.role = new_role
            user.save()
            return Response({
                "message": f"Rôle modifié de {old_role} à {new_role}",
                "user_id": user.id,
                "email": user.email,
                "new_role": user.role,
            })
        except CustomUser.DoesNotExist:
            return Response({"error": "Utilisateur introuvable"}, status=status.HTTP_404_NOT_FOUND)

# =========================
# TOTALS VIEW
# =========================
class TotalsView(APIView):
    permission_classes = [IsAuthenticated]
    def get(self, request):
        user = request.user
        if user.role == "admin":
            products = Product.objects.filter(magasin__admins=user)
        elif user.role == "magasin":
            products = Product.objects.filter(magasin__user=user)
        elif user.role == "employer":
            products = Product.objects.filter(magasin__employers__user=user)
        else:
            products = Product.objects.none()

        total_unit = products.aggregate(total=Sum('unit_price'))['total'] or 0
        total_shell = products.aggregate(total=Sum('shell_price'))['total'] or 0
        return Response({
            'total_unit_price': total_unit,
            'total_shell_price': total_shell,
        })

# =========================
# PROFIT VIEW
# =========================
class ProfitView(APIView):
    permission_classes = [IsAuthenticated, IsAdmin]

    def get(self, request):
        # For admins, retrieve all sales
        if request.user.role == "admin":
            sales_qs = Sale.objects.filter(magasin__admins=request.user)
        else:
            sales_qs = Sale.objects.none()
        revenue, cost, profit, _ = _sale_totals(sales_qs)
        return Response({
            'total_revenue': revenue,
            'total_cost': cost,
            'total_profit': profit,
        })


# =========================
# ADMIN MAGASIN PROFIT VIEW
# =========================
class AdminMagasinProfitView(APIView):
    permission_classes = [IsAuthenticated, IsAdmin]

    def get(self, request):
        magasins = MagasinProfile.objects.filter(Q(admin=request.user) | Q(admins=request.user)).distinct()
        data = []
        for magasin in magasins:
            sales_qs = Sale.objects.filter(magasin=magasin)
            total_revenue, total_cost, total_profit, total_quantity = _sale_totals(sales_qs)
            data.append({
                'magasin_id': magasin.id,
                'shop_name': magasin.shop_name,
                'total_quantity_sold': total_quantity,
                'total_revenue': total_revenue,
                'total_cost': total_cost,
                'total_profit': total_profit,
            })

        return Response({'profit_by_magasins': data})


class AdminMagasinOverviewView(APIView):
    permission_classes = [IsAuthenticated, IsAdmin]

    def get(self, request):
        week_start = timezone.now() - timedelta(days=7)
        magasins = MagasinProfile.objects.filter(Q(admin=request.user) | Q(admins=request.user)).distinct()
        response_data = []

        for magasin in magasins:
            products_qs = Product.objects.filter(magasin=magasin)
            sales_qs = Sale.objects.filter(magasin=magasin)

            total_stock_value = products_qs.aggregate(
                total=Coalesce(
                    Sum(F("initial_quantity") * F("purchase_price"), output_field=DecimalField()),
                    0,
                    output_field=DecimalField(),
                )
            )["total"]

            _, _, total_profit, _ = _sale_totals(sales_qs)

            response_data.append({
                "magasin_id": magasin.id,
                "shop_name": magasin.shop_name,
                "total_stock_value": total_stock_value,
                "total_profit": total_profit,
                "number_of_products": products_qs.count(),
                "number_of_sales_week": sales_qs.filter(sold_at__gte=week_start).count(),
                "number_of_employees": EmployerProfile.objects.filter(magasin=magasin).count(),
            })

        return Response({"magasins": response_data})


# =========================
# SALE VIEWSET
# =========================
class SaleViewSet(viewsets.ModelViewSet):
    serializer_class = SaleSerializer
    permission_classes = [IsAuthenticated]
    def get_queryset(self):
        user = self.request.user
        base_qs = Sale.objects.select_related('product', 'magasin', 'seller')
        if user.role == "admin":
            return base_qs.filter(magasin__admins=user)
        elif user.role == "magasin":
            try:
                magasin = MagasinProfile.objects.get(user=user)
                return base_qs.filter(magasin=magasin)
            except MagasinProfile.DoesNotExist:
                return Sale.objects.none()
        elif user.role == "employer":
            return base_qs.filter(magasin__employers__user=user)
        return Sale.objects.none()
    def perform_create(self, serializer):
        validated = serializer.validated_data
        product = validated.get('product')
        user = self.request.user

        # Security check: ensure the product belongs to the current user's company/store
        if user.role == "admin":
            if not product.magasin or user not in product.magasin.admins.all():
                raise serializers.ValidationError({"product": "Ce produit n'appartient pas à l'un de vos magasins."})
        elif user.role == "magasin":
            if not product.magasin or user not in product.magasin.admins.all():
                raise serializers.ValidationError({"product": "Ce produit n'appartient pas à l'un de vos magasins."})
        elif user.role == "employer":
            try:
                employer = EmployerProfile.objects.get(user=user)
                if not product.magasin or product.magasin != employer.magasin:
                    raise serializers.ValidationError({"product": "Ce produit n'appartient pas à votre magasin d'affectation."})
            except EmployerProfile.DoesNotExist:
                raise serializers.ValidationError({"detail": "Profil employé introuvable."})

        if validated.get('is_paid', True) and not validated.get('payment_date'):
            serializer.validated_data['payment_date'] = timezone.now()
        if not validated.get('is_paid', True) and not validated.get('payment_due_date'):
            serializer.validated_data['payment_due_date'] = (timezone.now().date() + timedelta(days=7))
        old_qty = product.initial_quantity or 0
        sale = serializer.save(seller=self.request.user, magasin=product.magasin)
        product.initial_quantity -= sale.quantity
        product.total_profit += sale.total_profit
        product.save()
        Movement.objects.create(
            product=product,
            product_name=product.name,
            magasin=product.magasin,
            changed_by=self.request.user,
            previous_quantity=old_qty,
            new_quantity=product.initial_quantity,
            change=-sale.quantity,
            note=f"Vente par {self.request.user.full_name}"
        )


class MovementViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = MovementSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        qs = Movement.objects.select_related('product', 'magasin', 'changed_by')
        if user.role == 'admin':
            return qs.filter(magasin__admins=user)
        elif user.role == 'magasin':
            try:
                magasin = MagasinProfile.objects.get(user=user)
                return qs.filter(magasin=magasin)
            except MagasinProfile.DoesNotExist:
                return Movement.objects.none()
        elif user.role == 'employer':
            try:
                employer = EmployerProfile.objects.get(user=user)
                if employer.magasin:
                    return qs.filter(magasin=employer.magasin)
            except EmployerProfile.DoesNotExist:
                pass
        return Movement.objects.none()


# =========================
# PRODUCT VIEWSET
# =========================
class ProductViewSet(viewsets.ModelViewSet):
    serializer_class = ProductSerializer
    permission_classes = [IsAuthenticated]
    def get_queryset(self):
        user = self.request.user
        base_qs = Product.objects.select_related('magasin')
        if user.role == "admin":
            qs = base_qs.filter(magasin__admins=user)
        elif user.role == "magasin":
            try:
                magasin = MagasinProfile.objects.get(user=user)
                qs = base_qs.filter(magasin=magasin)
            except MagasinProfile.DoesNotExist:
                return Product.objects.none()
        elif user.role == "employer":
            qs = base_qs.filter(magasin__employers__user=user)
        else:
            return Product.objects.none()

        store_id = self.request.query_params.get('store_id') or self.request.query_params.get('magasin_id')
        if store_id:
            qs = qs.filter(magasin_id=store_id)

        category = self.request.query_params.get('category')
        if category:
            qs = qs.filter(category=category)

        search = self.request.query_params.get('search')
        if search:
            qs = qs.filter(
                Q(name__icontains=search)
                | Q(reference__icontains=search)
                | Q(brand__icontains=search)
                | Q(category__icontains=search)
            )

        return qs
    def perform_create(self, serializer):
        user = self.request.user
        magasin = None
        if user.role == "magasin":
            try:
                magasin = MagasinProfile.objects.get(user=user)
            except MagasinProfile.DoesNotExist:
                raise serializers.ValidationError({"detail": "Profil magasin introuvable."})
        elif user.role == "admin":
            magasin_id = self.request.data.get("magasin")
            if magasin_id:
                try:
                    magasin = MagasinProfile.objects.get(id=magasin_id, admins=user)
                except MagasinProfile.DoesNotExist:
                    raise serializers.ValidationError({"magasin": "Magasin introuvable ou invalide pour cet administrateur."})
            else:
                raise serializers.ValidationError({"magasin": "Le magasin est obligatoire pour créer un produit."})
        elif user.role == "employer":
            try:
                employer = EmployerProfile.objects.get(user=user)
                magasin = employer.magasin
                if not magasin:
                    raise serializers.ValidationError({"detail": "Aucun magasin associé à cet employé."})
            except EmployerProfile.DoesNotExist:
                raise serializers.ValidationError({"detail": "Profil employé introuvable."})
        variants_raw = self.request.data.get('variants', '[]')
        try:
            variants_data = json.loads(variants_raw) if isinstance(variants_raw, str) else variants_raw
        except (json.JSONDecodeError, TypeError):
            variants_data = []

        if variants_data:
            variants_sum = sum(int(v.get('quantity', 0)) for v in variants_data)
            # Respect explicit initial_quantity from request (e.g. manual Quantité in Excel import)
            explicit_qty_raw = self.request.data.get('initial_quantity', None)
            if explicit_qty_raw not in (None, '', '0'):
                try:
                    total_qty = max(int(explicit_qty_raw), variants_sum)
                except (ValueError, TypeError):
                    total_qty = variants_sum
            else:
                total_qty = variants_sum
            product = serializer.save(magasin=magasin, initial_quantity=total_qty)
            created_variant_labels = []
            for v in variants_data:
                qty = int(v.get('quantity', 0))
                if qty > 0:
                    ProductVariant.objects.create(
                        product=product,
                        size=v.get('size', '') or '',
                        color=v.get('color', '') or '',
                        quantity=qty,
                    )
                    label = _variant_label(v.get('size'), v.get('color'))
                    if label:
                        created_variant_labels.append(label)
            variant_label = ', '.join(created_variant_labels) or None
        else:
            product = serializer.save(magasin=magasin)
            variant_label = None

        Movement.objects.create(
            product=product,
            product_name=product.name,
            variant_label=variant_label,
            magasin=magasin,
            changed_by=user,
            previous_quantity=0,
            new_quantity=product.initial_quantity,
            change=product.initial_quantity,
            previous_unit_price=None,
            new_unit_price=product.unit_price,
            previous_shell_price=None,
            new_shell_price=product.shell_price,
            note=f"Nouveau produit créé par {user.full_name}"
        )
        if not product.qr_code:
            _auto_generate_qr(product)

    def update(self, request, *args, **kwargs):
        user = request.user
        instance = self.get_object()
        old_qty = int(instance.initial_quantity or 0)
        old_unit_price = instance.unit_price
        old_shell_price = instance.shell_price
        old_name = instance.name
        old_reference = instance.reference
        old_brand = instance.brand
        old_category = instance.category
        old_description = instance.description
        old_expiry_date = instance.expiry_date

        if user.role == "admin":
            variants_raw = request.data.get('variants', None)
            if variants_raw is not None:
                try:
                    variants_data = json.loads(variants_raw) if isinstance(variants_raw, str) else variants_raw
                except (json.JSONDecodeError, TypeError):
                    variants_data = []
            else:
                variants_data = None

            response = super().update(request, *args, **kwargs)
            new_instance = self.get_object()

            updated_variant_labels = []
            if variants_data is not None:
                new_instance.variants.all().delete()
                total_qty = 0
                for v in variants_data:
                    qty = int(v.get('quantity', 0))
                    if qty > 0:
                        ProductVariant.objects.create(
                            product=new_instance,
                            size=v.get('size', '') or '',
                            color=v.get('color', '') or '',
                            quantity=qty,
                        )
                        total_qty += qty
                        label = _variant_label(v.get('size'), v.get('color'))
                        if label:
                            updated_variant_labels.append(label)
                if variants_data:
                    new_instance.initial_quantity = total_qty
                    new_instance.save(update_fields=['initial_quantity'])

            new_qty = int(new_instance.initial_quantity or 0)
            changed_fields = []
            movement_data = {
                'product': new_instance,
                'product_name': new_instance.name,
                'variant_label': ', '.join(updated_variant_labels) or None,
                'magasin': new_instance.magasin,
                'changed_by': user,
                'previous_quantity': old_qty,
                'new_quantity': new_qty,
                'change': new_qty - old_qty,
            }

            if 'initial_quantity' in request.data and new_qty != old_qty:
                changed_fields.append(f"stock {new_qty - old_qty:+d}")
            if variants_data is not None and updated_variant_labels:
                changed_fields.append(f"variantes: {', '.join(updated_variant_labels)}")
            if 'unit_price' in request.data and float(new_instance.unit_price) != float(old_unit_price):
                movement_data['previous_unit_price'] = old_unit_price
                movement_data['new_unit_price'] = new_instance.unit_price
                changed_fields.append(f"prix unitaire {old_unit_price}→{new_instance.unit_price}")
            if 'shell_price' in request.data and float(new_instance.shell_price) != float(old_shell_price):
                movement_data['previous_shell_price'] = old_shell_price
                movement_data['new_shell_price'] = new_instance.shell_price
                changed_fields.append(f"prix caisse {old_shell_price}→{new_instance.shell_price}")
            if 'name' in request.data and new_instance.name != old_name:
                changed_fields.append("nom")
            if 'reference' in request.data and new_instance.reference != old_reference:
                changed_fields.append("référence")
            if 'brand' in request.data and new_instance.brand != old_brand:
                changed_fields.append("marque")
            if 'category' in request.data and new_instance.category != old_category:
                changed_fields.append("catégorie")
            if 'description' in request.data and new_instance.description != old_description:
                changed_fields.append("description")
            if 'expiry_date' in request.data and new_instance.expiry_date != old_expiry_date:
                changed_fields.append("date d'expiration")

            if changed_fields:
                movement_data['note'] = f"Mise à jour produit par {user.full_name} : {', '.join(changed_fields)}"
                Movement.objects.create(**movement_data)
                Notification.objects.create(
                    notif_type='product',
                    message=f"Mise à jour produit: {new_instance.name} ({', '.join(changed_fields)}) par {user.full_name}",
                    magasin=new_instance.magasin,
                    product=new_instance,
                    user=user
                )
            return response

        if user.role == "magasin":
            try:
                magasin = MagasinProfile.objects.get(user=user)
            except MagasinProfile.DoesNotExist:
                return Response({"error": "Magasin introuvable"}, status=404)

            if instance.magasin is None or instance.magasin.id != magasin.id:
                return Response({"error": "Seul admin peut modifier"}, status=403)

            blocked_fields = [
                'unit_price',
                'shell_price',
                'name',
                'reference',
                'brand',
                'category',
                'description',
                'expiry_date',
            ]
            if any(field in request.data for field in blocked_fields):
                return Response({"error": "Seuls les admins peuvent modifier les détails ou les prix du produit."}, status=403)

            if 'initial_quantity' not in request.data:
                return Response({"error": "Seul admin peut modifier"}, status=403)

            try:
                new_qty = int(request.data.get('initial_quantity'))
            except Exception:
                return Response({"error": "Quantité invalide"}, status=400)

            if new_qty < old_qty:
                return Response({"error": "Seul admin peut modifier"}, status=403)

            instance.initial_quantity = new_qty
            instance.save()

            Movement.objects.create(
                product=instance,
                product_name=instance.name,
                magasin=magasin,
                changed_by=user,
                previous_quantity=old_qty,
                new_quantity=new_qty,
                change=new_qty - old_qty,
                note=f"Ajout manuel par {user.full_name}"
            )
            Notification.objects.create(
                notif_type='product',
                message=f"Entrée de stock: {instance.name} +{new_qty - old_qty} unités par {user.full_name}",
                magasin=magasin,
                product=instance,
                user=user
            )

            serializer = self.get_serializer(instance)
            return Response(serializer.data)

        return Response({"error": "Seul admin peut modifier"}, status=403)
    def destroy(self, request, *args, **kwargs):
        if request.user.role != "admin":
            return Response({"error": "Seul admin peut supprimer"}, status=403)
        instance = self.get_object()
        Movement.objects.create(
            product=instance,
            product_name=instance.name,
            magasin=instance.magasin,
            changed_by=request.user,
            previous_quantity=instance.initial_quantity or 0,
            new_quantity=0,
            change=-(instance.initial_quantity or 0),
            note=f"Suppression produit par {request.user.full_name}"
        )
        Notification.objects.create(
            notif_type='product',
            message=f"Suppression de produit: {instance.name} par {request.user.full_name}",
            magasin=instance.magasin,
            product=instance,
            user=request.user
        )
        return super().destroy(request, *args, **kwargs)


# =========================
# NOTIFICATION VIEWSET
# =========================
class NotificationViewSet(viewsets.ModelViewSet):
    serializer_class = NotificationSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        qs = Notification.objects.select_related('magasin','product','sale','user')
        if user.role == 'admin':
            return qs.filter(Q(magasin__admins=user) | Q(user=user)).distinct()
        elif user.role == 'magasin':
            try:
                magasin = MagasinProfile.objects.get(user=user)
                return qs.filter(Q(magasin=magasin) | Q(user=user)).distinct()
            except MagasinProfile.DoesNotExist:
                return qs.filter(user=user)
        elif user.role == 'employer':
            try:
                employer = EmployerProfile.objects.filter(user=user).first()
                if employer and employer.magasin:
                    return qs.filter(Q(magasin=employer.magasin) | Q(user=user)).distinct()
            except Exception:
                pass
            return qs.filter(user=user)

    @action(detail=False, methods=['post'], url_path='mark-all-read')
    def mark_all_read(self, request):
        """Marque toutes les notifications visibles comme lues."""
        self.get_queryset().update(is_read=True)
        return Response({"message": "Toutes les notifications marquées comme lues."})

    @action(detail=False, methods=['post'], url_path='delete-all')
    def delete_all(self, request):
        """Supprime toutes les notifications visibles."""
        self.get_queryset().delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=False, methods=['post'], url_path='bulk-delete')
    def bulk_delete(self, request):
        """Supprime une sélection spécifique de notifications."""
        ids = request.data.get('ids', [])
        self.get_queryset().filter(id__in=ids).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=False, methods=['post'], url_path='bulk-read')
    def bulk_read(self, request):
        """Marque une sélection spécifique comme lue."""
        ids = request.data.get('ids', [])
        self.get_queryset().filter(id__in=ids).update(is_read=True)
        return Response({"message": "Notifications marquées comme lues."})

    def partial_update(self, request, *args, **kwargs):
        # allow marking as read
        instance = self.get_object()
        is_read = request.data.get('is_read', None)
        if is_read is not None:
            instance.is_read = bool(is_read)
            instance.save()
            return Response(self.get_serializer(instance).data)
        return super().partial_update(request, *args, **kwargs)

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        user = request.user

        if user.role == 'admin':
            return super().destroy(request, *args, **kwargs)

        if instance.user_id == user.id:
            return super().destroy(request, *args, **kwargs)

        if user.role in ['magasin', 'employer']:
            magasin = None
            try:
                if user.role == 'magasin':
                    magasin = MagasinProfile.objects.get(user=user)
                else:
                    employer = EmployerProfile.objects.filter(user=user).first()
                    magasin = employer.magasin if employer else None
            except Exception:
                magasin = None
            if instance.magasin and magasin and instance.magasin.id == magasin.id:
                return super().destroy(request, *args, **kwargs)

        return Response({"error": "Permission refusée"}, status=403)

# =========================
# USERS BY MAGASIN VIEW
# =========================
class UsersByMagasinView(APIView):
    permission_classes = [IsAuthenticated]
    def get(self, request):
        user = request.user
        response_data = []
        company_users = []
        seen_user_ids = set()

        def add_company_user(user_obj, shop_name=None, magasin_id=None, position=None):
            if not user_obj or user_obj.id in seen_user_ids:
                return
            seen_user_ids.add(user_obj.id)
            company_users.append({
                "id": user_obj.id,
                "full_name": user_obj.full_name,
                "email": user_obj.email,
                "is_confirmed": user_obj.is_confirmed,
                "role": user_obj.role,
                "shop_name": shop_name,
                "magasin_id": magasin_id,
                "position": position,
            })

        # Admin can see all magasins belonging to them
        if user.role == "admin":
            magasins = MagasinProfile.objects.filter(Q(admin=user) | Q(admins=user)).distinct()
        # Magasin can see only their own magasin
        elif user.role == "magasin":
            magasins = MagasinProfile.objects.filter(user=user)
        # Employer can see only their own magasin
        elif user.role == "employer":
            try:
                employer_profile = EmployerProfile.objects.get(user=user)
                if employer_profile.magasin:
                    magasins = MagasinProfile.objects.filter(id=employer_profile.magasin.id)
                else:
                    return Response([])
            except EmployerProfile.DoesNotExist:
                return Response({"error": "Employer profile not found"}, status=404)
        else:
            return Response({"error": "Role not supported"}, status=403)

        for mag in magasins:
            manager_data = {
                "id": mag.admin.id,
                "full_name": mag.admin.full_name,
                "email": mag.admin.email,
                "is_confirmed": mag.admin.is_confirmed,
                "role": mag.admin.role,
            } if mag.admin else None
            if manager_data:
                add_company_user(mag.admin, mag.shop_name, mag.id)

            employers_qs = EmployerProfile.objects.filter(magasin=mag)
            employers_list = []
            for emp in employers_qs:
                employers_list.append({
                    "id": emp.user.id,
                    "full_name": emp.user.full_name,
                    "email": emp.user.email,
                    "is_confirmed": emp.user.is_confirmed,
                    "position": emp.position,
                    "role": emp.user.role,
                })
                add_company_user(emp.user, mag.shop_name, mag.id, emp.position)

            for admin_user in mag.admins.all():
                add_company_user(admin_user, mag.shop_name, mag.id)

            response_data.append({
                "magasin_id": mag.id,
                "shop_name": mag.shop_name,
                "shop_logo": request.build_absolute_uri(mag.shop_logo.url) if mag.shop_logo else None,
                "manager": manager_data,
                "employers": employers_list,
                "company_users": company_users,
            })

        return Response(response_data)


class MagasinStatsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user

        if user.role == "admin":
            magasins = MagasinProfile.objects.filter(Q(admin=user) | Q(admins=user)).distinct()
        elif user.role == "magasin":
            magasins = MagasinProfile.objects.filter(user=user)
        elif user.role == "employer":
            try:
                employer_profile = EmployerProfile.objects.get(user=user)
                if employer_profile.magasin:
                    magasins = MagasinProfile.objects.filter(id=employer_profile.magasin.id)
                else:
                    return Response([])
            except EmployerProfile.DoesNotExist:
                return Response({"error": "Employer profile not found"}, status=404)
        else:
            return Response({"error": "Role not supported"}, status=403)

        response_data = []

        for mag in magasins:
            products_qs = Product.objects.filter(magasin=mag)
            sales_qs = Sale.objects.filter(magasin=mag)

            total_products = products_qs.count()
            total_stock_quantity = products_qs.aggregate(
                total=Coalesce(Sum('initial_quantity'), 0)
            )['total']
            total_stock_value = products_qs.aggregate(
                total=Coalesce(Sum(F('initial_quantity') * F('purchase_price'), output_field=DecimalField()), 0, output_field=DecimalField())
            )['total']
            total_sold_value = sales_qs.aggregate(
                total=Coalesce(Sum('total_price', output_field=DecimalField()), 0, output_field=DecimalField())
            )['total']
            # compute profit = sum of total_profit from each sale
            profit = sales_qs.aggregate(total=Coalesce(Sum('total_profit', output_field=DecimalField()), Value(0), output_field=DecimalField()))['total']

            response_data.append({
                "magasin_id": mag.id,
                "shop_name": mag.shop_name,
                "total_products": total_products,
                "total_stock_quantity": total_stock_quantity,
                "total_stock_value": total_stock_value,
                "total_sold_value": total_sold_value,
                "profit": profit,
            })

        return Response(response_data)


# =========================
# DASHBOARD VIEW
# =========================
class DashboardView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user
        role = user.role
        today = timezone.now().date()

        if role == "admin":
            # KPIs scoped to admin
            admin_sales = Sale.objects.filter(magasin__admin=user)
            admin_products = Product.objects.filter(magasin__admin=user)
            admin_magasins = MagasinProfile.objects.filter(admin=user)
            admin_employers = EmployerProfile.objects.filter(Q(admin=user) | Q(magasin__admin=user))

            total_revenue, _, total_profit, _ = _sale_totals(admin_sales)
            total_stock_value = admin_products.aggregate(total=Sum(F('initial_quantity') * F('purchase_price'), output_field=DecimalField()))['total'] or 0
            total_magasins = admin_magasins.count()
            total_employers = admin_employers.count()
            total_products = admin_products.count()
            total_sales = admin_sales.count()
            sales_today = admin_sales.filter(sold_at__date=today).count()
            _, _, profit_today, _ = _sale_totals(admin_sales.filter(sold_at__date=today))
            low_stock_count = admin_products.filter(initial_quantity__lte=F('alert_threshold')).count()
            expired_count = admin_products.filter(expiry_date__lt=today).count()
            expiring_soon_count = admin_products.filter(expiry_date__range=[today, today + timedelta(days=30)]).count()
            unpaid_sales_count, unpaid_sales_value = _unpaid_sales_metrics(admin_sales)

            # Lists scoped to admin
            top_products = admin_sales.values('product__name', 'product__magasin__shop_name').annotate(
                qty_sold=Sum('quantity'),
                profit=Sum('total_profit')
            ).order_by('-qty_sold')[:5]

            bottom_products = admin_products.values('name', 'initial_quantity').annotate(
                qty_sold=Coalesce(Sum('sales__quantity'), 0)
            ).order_by('qty_sold')[:5]

            low_stock_list = admin_products.filter(initial_quantity__lte=F('alert_threshold')).values(
                'name', 'initial_quantity', 'alert_threshold', 'magasin__shop_name'
            )[:5]

            expired_list = admin_products.filter(expiry_date__lt=today).values(
                'name', 'expiry_date', 'magasin__shop_name'
            )[:5]

            expiring_soon_list = admin_products.filter(expiry_date__range=[today, today + timedelta(days=30)]).values(
                'name', 'expiry_date', 'magasin__shop_name'
            )[:5]

            recent_sales_qs = admin_sales.select_related('product', 'magasin', 'seller').order_by('-sold_at')[:5]
            recent_sales = []
            for sale in recent_sales_qs:
                recent_sales.append({
                    "product_name": sale.product.name,
                    "quantity": sale.quantity,
                    "sale_price": sale.sale_price,
                    "total_price": sale.total_price,
                    "seller_name": sale.seller.full_name if sale.seller else None,
                    "shop_name": sale.magasin.shop_name if sale.magasin else None,
                    "sold_at": sale.sold_at
                })

            best_employees = admin_sales.values('seller__full_name').annotate(
                sales_count=Count('id'),
                total_amount=Sum('total_price'),
                profit=Sum('total_profit')
            ).order_by('-total_amount')[:5]

            best_shops = admin_sales.values('magasin__shop_name').annotate(
                total_amount=Sum('total_price'),
                sales_count=Count('id'),
                total_stock=Coalesce(Sum('product__initial_quantity'), 0)
            ).order_by('-total_amount')[:5]

            return Response({
                "role": role,
                "kpis": {
                    "total_revenue": total_revenue,
                    "total_profit": total_profit,
                    "total_stock_value": total_stock_value,
                    "total_magasins": total_magasins,
                    "total_employers": total_employers,
                    "total_products": total_products,
                    "total_sales": total_sales,
                    "sales_today": sales_today,
                    "profit_today": profit_today,
                    "low_stock_count": low_stock_count,
                    "expired_count": expired_count,
                    "expiring_soon_count": expiring_soon_count,
                    "unpaid_sales_count": unpaid_sales_count,
                    "unpaid_sales_value": unpaid_sales_value,
                },
                "lists": {
                    "top_products": top_products,
                    "bottom_products": bottom_products,
                    "low_stock_products": low_stock_list,
                    "expired_products": expired_list,
                    "expiring_soon_products": expiring_soon_list,
                    "recent_sales": recent_sales,
                    "best_employees": best_employees,
                    "best_shops": best_shops
                }
            })

        elif role == "magasin":
            try:
                magasin = MagasinProfile.objects.get(user=user)
            except MagasinProfile.DoesNotExist:
                return Response({"error": "Magasin profile not found"}, status=404)

            # KPIs (without exposing company wide purchase_price)
            sales_today = Sale.objects.filter(magasin=magasin, sold_at__date=today).count()
            _, _, profit_today, _ = _sale_totals(Sale.objects.filter(magasin=magasin, sold_at__date=today))
            total_revenue, _, total_profit, _ = _sale_totals(Sale.objects.filter(magasin=magasin))
            stock_value = Product.objects.filter(magasin=magasin).aggregate(total=Sum(F('initial_quantity') * F('purchase_price'), output_field=DecimalField()))['total'] or 0
            total_products = Product.objects.filter(magasin=magasin).count()
            total_sales = Sale.objects.filter(magasin=magasin).count()
            low_stock_count = Product.objects.filter(magasin=magasin, initial_quantity__lte=F('alert_threshold')).count()
            expired_count = Product.objects.filter(magasin=magasin, expiry_date__lt=today).count()
            unpaid_sales_count, unpaid_sales_value = _unpaid_sales_metrics(Sale.objects.filter(magasin=magasin))

            # Lists (never showing individual unit_price)
            top_products = Sale.objects.filter(magasin=magasin).values('product__name').annotate(
                qty_sold=Sum('quantity')
            ).order_by('-qty_sold')[:5]

            bottom_products = Product.objects.filter(magasin=magasin).values('name', 'initial_quantity').annotate(
                qty_sold=Coalesce(Sum('sales__quantity'), 0)
            ).order_by('qty_sold')[:5]

            low_stock_list = Product.objects.filter(magasin=magasin, initial_quantity__lte=F('alert_threshold')).values(
                'name', 'initial_quantity'
            )[:5]

            recent_sales_qs = Sale.objects.filter(magasin=magasin).select_related('product', 'seller').order_by('-sold_at')[:5]
            recent_sales = []
            for sale in recent_sales_qs:
                recent_sales.append({
                    "product_name": sale.product.name,
                    "quantity": sale.quantity,
                    "total_price": sale.total_price,
                    "seller_name": sale.seller.full_name if sale.seller else None,
                    "sold_at": sale.sold_at
                })

            best_sellers = Sale.objects.filter(magasin=magasin).values('seller__full_name').annotate(
                sales_count=Count('id'),
                total_amount=Sum('total_price')
            ).order_by('-total_amount')[:5]

            return Response({
                "role": role,
                "kpis": {
                    "sales_today": sales_today,
                    "profit_today": profit_today,
                    "total_revenue": total_revenue,
                    "total_profit": total_profit,
                    "stock_value": stock_value,
                    "total_products": total_products,
                    "total_sales": total_sales,
                    "low_stock_count": low_stock_count,
                    "expired_count": expired_count,
                    "unpaid_sales_count": unpaid_sales_count,
                    "unpaid_sales_value": unpaid_sales_value,
                },
                "lists": {
                    "top_products": top_products,
                    "bottom_products": bottom_products,
                    "low_stock_products": low_stock_list,
                    "recent_sales": recent_sales,
                    "best_sellers": best_sellers
                }
            })

        elif role == "employer":
            try:
                employer_profile = EmployerProfile.objects.get(user=user)
                magasin = employer_profile.magasin
            except EmployerProfile.DoesNotExist:
                return Response({"error": "Employer profile not found"}, status=404)

            # KPIs
            my_sales_today = Sale.objects.filter(seller=user, sold_at__date=today).count()
            total_amount_sold = Sale.objects.filter(seller=user).aggregate(total=Sum('total_price'))['total'] or 0
            products_sold_count = Sale.objects.filter(seller=user).aggregate(total=Sum('quantity'))['total'] or 0
            clients_count = Sale.objects.filter(seller=user).count()
            unpaid_sales_count, unpaid_sales_value = _unpaid_sales_metrics(Sale.objects.filter(seller=user))

            # Lists
            recent_sales_qs = Sale.objects.filter(seller=user).select_related('product').order_by('-sold_at')[:5]
            recent_sales = []
            for sale in recent_sales_qs:
                recent_sales.append({
                    "product_name": sale.product.name,
                    "quantity": sale.quantity,
                    "total_price": sale.total_price,
                    "sold_at": sale.sold_at
                })

            return Response({
                "role": role,
                "kpis": {
                    "my_sales_today": my_sales_today,
                    "total_amount_sold": total_amount_sold,
                    "products_sold_count": products_sold_count,
                    "clients_count": clients_count,
                    "unpaid_sales_count": unpaid_sales_count,
                    "unpaid_sales_value": unpaid_sales_value,
                },
                "lists": {
                    "recent_sales": recent_sales
                }
            })

        else:
            return Response({"error": "Role not supported"}, status=403)


# =========================
# API ENDPOINTS LIST VIEW
# =========================
class ApiEndpointsListView(APIView):
    permission_classes = []  # Publicly accessible endpoint exploration

    def get(self, request):
        endpoints = [
            {
                "path": "/api/users/login/",
                "method": "POST",
                "auth_required": False,
                "roles_allowed": ["Any"],
                "description": "Authentifie un utilisateur et retourne les tokens JWT (access & refresh)."
            },
            {
                "path": "/api/users/refresh/",
                "method": "POST",
                "auth_required": False,
                "roles_allowed": ["Any"],
                "description": "Rafraîchit le token d'accès JWT expiré."
            },
            {
                "path": "/api/users/register/",
                "method": "POST",
                "auth_required": False,
                "roles_allowed": ["Any"],
                "description": "Inscrit un nouvel utilisateur (admin créé automatiquement, magasin/employé en attente)."
            },
            {
                "path": "/api/users/me/",
                "method": "GET",
                "auth_required": True,
                "roles_allowed": ["admin", "magasin", "employer"],
                "description": "Retourne le profil complet et les informations de l'utilisateur connecté."
            },
            {
                "path": "/api/users/approve/<user_id>/",
                "method": "PUT",
                "auth_required": True,
                "roles_allowed": ["admin", "magasin"],
                "description": "Approuve et active un compte utilisateur en attente de validation."
            },
            {
                "path": "/api/users/role/<user_id>/",
                "method": "PUT",
                "auth_required": True,
                "roles_allowed": ["admin"],
                "description": "Modifie le rôle d'un utilisateur existant."
            },
            {
                "path": "/api/users/products/",
                "method": "GET, POST",
                "auth_required": True,
                "roles_allowed": ["admin", "magasin", "employer"],
                "description": "GET: Liste les produits (prix d'achat masqué pour magasin/employé). POST: Crée un nouveau produit."
            },
            {
                "path": "/api/users/products/<id>/",
                "method": "GET, PUT, PATCH, DELETE",
                "auth_required": True,
                "roles_allowed": ["admin", "magasin", "employer"],
                "description": "Consulte, modifie ou supprime un produit spécifique (Modifications/Suppression réservées aux admins)."
            },
            {
                "path": "/api/users/sales/",
                "method": "GET, POST",
                "auth_required": True,
                "roles_allowed": ["admin", "magasin", "employer"],
                "description": "GET: Historique des ventes de produits (filtré par magasin). POST: Enregistre une nouvelle transaction de vente."
            },
            {
                "path": "/api/users/sales/totals/",
                "method": "GET",
                "auth_required": True,
                "roles_allowed": ["admin", "magasin", "employer"],
                "description": "Calcule la somme globale des unit_price et shell_price de tous les produits."
            },
            {
                "path": "/api/users/sales/profit/",
                "method": "GET",
                "auth_required": True,
                "roles_allowed": ["admin"],
                "description": "Calcule le bénéfice réel total (somme de (sale_price - unit_price) * quantity) pour l'administrateur."
            },
            {
                "path": "/api/users/sales/profit-by-magasins/",
                "method": "GET",
                "auth_required": True,
                "roles_allowed": ["admin"],
                "description": "Liste le bénéfice total, le chiffre d'affaires et le coût pour chaque magasin appartenant à l'administrateur."
            },
            {
                "path": "/api/users/magasins/users/",
                "method": "GET",
                "auth_required": True,
                "roles_allowed": ["admin", "magasin", "employer"],
                "description": "Retourne la liste de tous les utilisateurs (managers et employés) regroupés par magasin."
            },
            {
                "path": "/api/users/dashboard/",
                "method": "GET",
                "auth_required": True,
                "roles_allowed": ["admin", "magasin", "employer"],
                "description": "Tableau de bord analytique dynamique adapté en temps réel au profil de l'utilisateur."
            },
            {
                "path": "/api/users/endpoints/",
                "method": "GET",
                "auth_required": False,
                "roles_allowed": ["Any"],
                "description": "Liste l'ensemble des endpoints disponibles avec leurs descriptions et permissions."
            }
        ]
        return Response(endpoints)


# =========================
# CHANGE PASSWORD VIEW
# =========================
class ChangePasswordView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        user = request.user
        old_password = request.data.get("old_password")
        new_password = request.data.get("new_password")
        if not old_password or not new_password:
            return Response({"detail": "Champs requis manquants"}, status=400)
        if not user.check_password(old_password):
            return Response({"detail": "Mot de passe actuel incorrect"}, status=400)
        if len(new_password) < 6:
            return Response({"detail": "Le mot de passe doit contenir au moins 6 caractères"}, status=400)
        user.set_password(new_password)
        user.save()
        return Response({"message": "Mot de passe changé avec succès"})


# =========================
# PENDING USERS VIEW
# =========================
class PendingUsersView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user
        if user.role not in ["admin", "magasin"]:
            return Response({"error": "Permission refusée"}, status=403)

        if user.role == "admin":
            pending_qs = CustomUser.objects.filter(
            Q(is_confirmed=False),
            Q(employer_profile__admin=user) | Q(employer_profile__magasin__admin=user)
        ).distinct()
        else:
            try:
                magasin = MagasinProfile.objects.get(user=user)
                employer_ids = EmployerProfile.objects.filter(magasin=magasin).values_list("user_id", flat=True)
                pending_qs = CustomUser.objects.filter(is_confirmed=False, id__in=employer_ids)
            except MagasinProfile.DoesNotExist:
                return Response({"error": "Magasin introuvable"}, status=404)

        data = []
        for u in pending_qs:
            item = {
                "id": u.id,
                "full_name": u.full_name,
                "email": u.email,
                "role": u.role,
                "created_at": u.created_at,
            }
            if u.role == "employer":
                try:
                    ep = u.employer_profile
                    item["position"] = ep.position
                    if ep.magasin:
                        item["shop_name"] = ep.magasin.shop_name
                except Exception:
                    pass
            elif u.role == "magasin":
                try:
                    mp = u.magasin_profile
                    item["shop_name"] = mp.shop_name
                except Exception:
                    pass
            data.append(item)

        return Response(data)


# =========================
# DELETE USER VIEW
# =========================
class DeleteUserView(APIView):
    permission_classes = [IsAuthenticated]

    def delete(self, request, user_id):
        current_user = request.user
        if current_user.role not in ["admin", "magasin"]:
            return Response({"error": "Permission refusée"}, status=403)

        user_admin = get_user_admin(current_user)
        if not user_admin:
            return Response({"error": "Permission refusée : entreprise introuvable."}, status=403)

        if current_user.role == "magasin":
            try:
                magasin = current_user.magasin_profile
                is_member = CustomUser.objects.filter(
                    id=user_id,
                    role="employer",
                    employer_profile__magasin=magasin
                ).exists()
                if not is_member:
                    return Response({"error": "Permission refusée : cet employé n'appartient pas à votre magasin."}, status=403)
            except Exception:
                return Response({"error": "Magasin introuvable"}, status=404)
        else: # admin
            is_member = CustomUser.objects.filter(
                Q(id=user_id),
                Q(magasin_profile__admin=user_admin) | Q(employer_profile__admin=user_admin) | Q(employer_profile__magasin__admin=user_admin)
            ).exists()
            if not is_member:
                return Response({"error": "Permission refusée : cet utilisateur n'appartient pas à votre entreprise."}, status=403)

        try:
            user = CustomUser.objects.get(id=user_id)
            if user.id == request.user.id:
                return Response({"error": "Vous ne pouvez pas vous supprimer vous-même"}, status=400)
            user.delete()
            return Response({"message": "Utilisateur supprimé"})
        except CustomUser.DoesNotExist:
            return Response({"error": "Utilisateur introuvable"}, status=404)


# =========================
# REJECT USER VIEW
# =========================
class RejectUserView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, user_id):
        current_user = request.user
        if current_user.role not in ["admin", "magasin"]:
            return Response({"error": "Permission refusée"}, status=403)

        user_admin = get_user_admin(current_user)
        if not user_admin:
            return Response({"error": "Permission refusée : entreprise introuvable."}, status=403)

        if current_user.role == "magasin":
            try:
                magasin = current_user.magasin_profile
                is_member = CustomUser.objects.filter(
                    id=user_id,
                    role="employer",
                    employer_profile__magasin=magasin
                ).exists()
                if not is_member:
                    return Response({"error": "Permission refusée : cet employé n'appartient pas à votre magasin."}, status=403)
            except Exception:
                return Response({"error": "Magasin introuvable"}, status=404)
        else: # admin
            is_member = CustomUser.objects.filter(
                Q(id=user_id),
                Q(magasin_profile__admin=user_admin) | Q(employer_profile__admin=user_admin) | Q(employer_profile__magasin__admin=user_admin)
            ).exists()
            if not is_member:
                return Response({"error": "Permission refusée : cet utilisateur n'appartient pas à votre entreprise."}, status=403)

        try:
            user = CustomUser.objects.get(id=user_id)
            user.delete()
            return Response({"message": "Utilisateur rejeté et supprimé"})
        except CustomUser.DoesNotExist:
            return Response({"error": "Utilisateur introuvable"}, status=404)


# =========================
# MAGASIN VIEWSET
# =========================
class MagasinViewSet(viewsets.ModelViewSet):
    serializer_class = MagasinProfileSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        if user.role == "admin":
            return MagasinProfile.objects.filter(admin=user)
        elif user.role == "magasin":
            return MagasinProfile.objects.filter(user=user)
        return MagasinProfile.objects.none()

    def perform_create(self, serializer):
        if self.request.user.role != "admin":
            raise serializers.ValidationError("Seul l'admin peut créer un magasin.")
        serializer.save(admin=self.request.user)

    def partial_update(self, request, *args, **kwargs):
        instance = self.get_object()
        shop_name = request.data.get("shop_name")
        shop_logo = request.data.get("shop_logo")
        if shop_name is not None:
            instance.shop_name = shop_name
        if shop_logo is not None and not isinstance(shop_logo, str):
            instance.shop_logo = shop_logo
        instance.save()
        serializer = self.get_serializer(instance)
        return Response(serializer.data)


# =========================
# CHAT VIEWS
# =========================
class ChatUsersListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        magasins = get_company_magasins(request.user)
        if not magasins.exists():
            return Response([])

        users = CustomUser.objects.filter(
            Q(is_confirmed=True),
            Q(magasins__in=magasins) |
            Q(admin_magasin_profiles__in=magasins) |
            Q(magasin_profile__in=magasins) |
            Q(employer_profile__magasin__in=magasins)
        ).exclude(id=request.user.id).distinct()

        data = []
        for u in users:
            user_info = {
                "id": u.id,
                "full_name": u.full_name,
                "email": u.email,
                "role": u.role,
            }
            if u.role == "magasin":
                try:
                    user_info["shop_name"] = u.magasin_profile.shop_name
                except Exception:
                    pass
            elif u.role == "employer":
                try:
                    user_info["shop_name"] = u.employer_profile.magasin.shop_name
                except Exception:
                    pass
            data.append(user_info)
        return Response(data)


class ChatMessageHistoryView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        from django.db.models import Q
        room_name = request.query_params.get("room_name", "general")
        recipient_id = request.query_params.get("recipient_id")

        my_magasins = get_company_magasins(request.user)
        if not my_magasins.exists():
            return Response([])

        if recipient_id:
            try:
                recipient = CustomUser.objects.get(id=recipient_id)
                # Verify recipient belongs to the same company (shares at least one magasin)
                recipient_magasins = get_company_magasins(recipient)
                if not recipient_magasins.exists() or not my_magasins.filter(id__in=recipient_magasins).exists():
                    return Response({"error": "Permission refusée"}, status=403)

                messages = ChatMessage.objects.filter(
                    Q(sender=request.user, recipient=recipient) |
                    Q(sender=recipient, recipient=request.user)
                ).order_by("timestamp")
            except CustomUser.DoesNotExist:
                return Response({"error": "Destinataire introuvable"}, status=404)
        else:
            company_id = get_company_id(request.user)
            if not company_id:
                return Response([])
            scoped_room = f"general_{company_id}"
            messages = ChatMessage.objects.filter(room_name=scoped_room, recipient__isnull=True).order_by("timestamp")

        # Take last 100 messages
        total_count = messages.count()
        messages = messages[max(0, total_count - 100):]
        serializer = ChatMessageSerializer(messages, many=True)
        return Response(serializer.data)

class TransferProductsView(APIView):
    permission_classes = [IsAuthenticated]

    def _unique_reference(self, base_ref, dest_id):
        candidate = f"{base_ref}-TR{dest_id}"
        counter = 1
        while Product.objects.filter(reference=candidate).exists():
            candidate = f"{base_ref}-TR{dest_id}-{counter}"
            counter += 1
        return candidate

    def _normalize_items(self, request):
        items = request.data.get("items")
        if isinstance(items, list) and len(items) > 0:
            return items
        product_ids = request.data.get("product_ids", [])
        if isinstance(product_ids, list) and len(product_ids) > 0:
            return [{"product_id": pid, "quantity": None} for pid in product_ids]
        return []

    def post(self, request):
        user = request.user
        if user.role != "admin":
            return Response({"error": "Permission refusée"}, status=403)
        source_id = request.data.get("source_magasin_id")
        destination_id = request.data.get("destination_magasin_id")
        raw_items = self._normalize_items(request)
        if not source_id or not destination_id or not raw_items:
            return Response({"error": "Paramètres manquants ou invalides"}, status=400)
        try:
            source_magasin = MagasinProfile.objects.get(id=source_id, admin=user)
            dest_magasin = MagasinProfile.objects.get(id=destination_id, admin=user)
        except MagasinProfile.DoesNotExist:
            return Response({"error": "Magasin source ou destination introuvable ou non autorisé"}, status=404)

        transfer_note = f"Transfert du magasin {source_magasin.id} au magasin {dest_magasin.id} par {user.full_name}"
        transferred_summary = []

        for raw_item in raw_items:
            product_id = raw_item.get("product_id")
            if not product_id:
                return Response({"error": "Identifiant produit manquant"}, status=400)
            try:
                product = Product.objects.get(id=product_id, magasin=source_magasin)
            except Product.DoesNotExist:
                return Response({"error": "Certains produits n'appartiennent pas au magasin source"}, status=400)

            stock = int(product.initial_quantity or 0)
            requested_qty = raw_item.get("quantity")
            quantity = stock if requested_qty is None else int(requested_qty)

            if quantity <= 0:
                return Response({"error": f"Quantité invalide pour {product.name}"}, status=400)
            if quantity > stock:
                return Response(
                    {"error": f"Stock insuffisant pour {product.name}. Disponible : {stock}."},
                    status=400,
                )

            transferred_summary.append(f"{product.name} x{quantity}")

            if quantity == stock:
                product.magasin = dest_magasin
                product.save()
                Movement.objects.create(
                    product=product,
                    product_name=product.name,
                    magasin=dest_magasin,
                    changed_by=user,
                    previous_quantity=stock,
                    new_quantity=stock,
                    change=0,
                    note=transfer_note,
                )
                continue

            previous_qty = stock
            product.initial_quantity = stock - quantity
            product.save()
            Movement.objects.create(
                product=product,
                product_name=product.name,
                magasin=source_magasin,
                changed_by=user,
                previous_quantity=previous_qty,
                new_quantity=product.initial_quantity,
                change=-quantity,
                note=f"{transfer_note} (sortie partielle)",
            )

            dest_product = Product.objects.filter(magasin=dest_magasin, name=product.name).first()
            if dest_product:
                dest_previous = int(dest_product.initial_quantity or 0)
                dest_product.initial_quantity = dest_previous + quantity
                dest_product.save()
            else:
                dest_product = Product.objects.create(
                    name=product.name,
                    reference=self._unique_reference(product.reference, dest_magasin.id),
                    brand=product.brand,
                    category=product.category,
                    description=product.description,
                    purchase_price=product.purchase_price,
                    unit_price=product.unit_price,
                    shell_price=product.shell_price,
                    initial_quantity=quantity,
                    alert_threshold=product.alert_threshold,
                    expiry_date=product.expiry_date,
                    magasin=dest_magasin,
                )
                dest_previous = 0

            Movement.objects.create(
                product=dest_product,
                product_name=dest_product.name,
                magasin=dest_magasin,
                changed_by=user,
                previous_quantity=dest_previous,
                new_quantity=dest_product.initial_quantity,
                change=quantity,
                note=f"{transfer_note} (entrée partielle)",
            )

        if transferred_summary:
            preview = ", ".join(transferred_summary[:3])
            if len(transferred_summary) > 3:
                preview += f" (+{len(transferred_summary) - 3} autre(s))"

            Notification.objects.create(
                notif_type="transfer",
                message=f"Transfert sortant vers {dest_magasin.shop_name} : {preview} — par {user.full_name}",
                magasin=source_magasin,
                user=user,
            )
            Notification.objects.create(
                notif_type="transfer",
                message=f"Transfert entrant depuis {source_magasin.shop_name} : {preview} — par {user.full_name}",
                magasin=dest_magasin,
                user=user,
            )

        return Response({"message": "Transfert effectué avec succès"})


class BackupExportView(APIView):
    """Export complet de la base de données (fixture JSON) + fichiers media (images, QR codes) dans un zip."""
    permission_classes = [IsAdmin]

    def get(self, request):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            data_buffer = io.StringIO()
            call_command(
                "dumpdata",
                exclude=[
                    "contenttypes",
                    "auth.permission",
                    "admin.logentry",
                    "sessions.session",
                ],
                indent=2,
                stdout=data_buffer,
            )
            zf.writestr("data.json", data_buffer.getvalue())

            media_root = str(settings.MEDIA_ROOT)
            if os.path.isdir(media_root):
                for root, _dirs, files in os.walk(media_root):
                    for filename in files:
                        file_path = os.path.join(root, filename)
                        arcname = os.path.join("media", os.path.relpath(file_path, media_root))
                        zf.write(file_path, arcname)

        buffer.seek(0)
        filename = f"backup_{timezone.now().strftime('%Y%m%d_%H%M%S')}.zip"
        response = HttpResponse(buffer.getvalue(), content_type="application/zip")
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        return response


class BackupImportView(APIView):
    """Restauration complète depuis un backup.zip : remplace toutes les données et les fichiers media."""
    permission_classes = [IsAdmin]
    parser_classes = [MultiPartParser]

    def post(self, request):
        uploaded = request.FILES.get("file")
        if not uploaded:
            return Response({"detail": "Aucun fichier fourni."}, status=status.HTTP_400_BAD_REQUEST)
        if not uploaded.name.lower().endswith(".zip"):
            return Response({"detail": "Le fichier doit être une archive .zip."}, status=status.HTTP_400_BAD_REQUEST)

        try:
            zf = zipfile.ZipFile(uploaded)
        except zipfile.BadZipFile:
            return Response({"detail": "Fichier zip invalide."}, status=status.HTTP_400_BAD_REQUEST)

        with zf:
            names = zf.namelist()
            if "data.json" not in names:
                return Response(
                    {"detail": "Archive invalide : data.json introuvable."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            data_content = zf.read("data.json")
            try:
                json.loads(data_content)
            except json.JSONDecodeError:
                return Response({"detail": "data.json invalide ou corrompu."}, status=status.HTTP_400_BAD_REQUEST)

            try:
                call_command("flush", interactive=False)

                tmp_path = None
                with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmp:
                    tmp.write(data_content)
                    tmp_path = tmp.name
                try:
                    call_command("loaddata", tmp_path)
                finally:
                    os.unlink(tmp_path)

                media_root = str(settings.MEDIA_ROOT)
                if os.path.isdir(media_root):
                    shutil.rmtree(media_root)
                os.makedirs(media_root, exist_ok=True)
                for name in names:
                    if name.startswith("media/") and not name.endswith("/"):
                        rel_path = name[len("media/"):]
                        target_path = os.path.join(media_root, rel_path)
                        os.makedirs(os.path.dirname(target_path), exist_ok=True)
                        with zf.open(name) as src, open(target_path, "wb") as dst:
                            shutil.copyfileobj(src, dst)
            except Exception as exc:
                return Response(
                    {"detail": f"Erreur lors de la restauration : {exc}"},
                    status=status.HTTP_500_INTERNAL_SERVER_ERROR,
                )

        return Response({"detail": "Backup restauré avec succès."})
