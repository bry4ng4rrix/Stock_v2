from rest_framework import serializers
from .models import (
    CustomUser,
    AdminProfile,
    MagasinProfile,
    EmployerProfile,
    Product,
    ProductVariant,
    Notification,
    Sale,
    Movement,
    ChatMessage,
)

class RegisterSerializer(serializers.ModelSerializer):
    company_name = serializers.CharField(required=False)
    shop_name = serializers.CharField(required=False)
    position = serializers.CharField(required=False)
    admin_email = serializers.EmailField(required=False)

    class Meta:
        model = CustomUser
        fields = [
            "id",
            "username",
            "full_name",
            "email",
            "password",
            "phone",
            "role",
            "company_name",
            "shop_name",
            "position",
            "admin_email",
        ]
        extra_kwargs = {"password": {"write_only": True}}

    def create(self, validated_data):
        role = validated_data.get("role")
        username = validated_data.pop("username", validated_data.get("email"))
        admin_email = validated_data.pop("admin_email", None)
        company_name = validated_data.pop("company_name", None)
        shop_name = validated_data.pop("shop_name", None)
        position = validated_data.pop("position", None)
        password = validated_data.pop("password")

        if role == "admin":
            company_name = company_name or validated_data.get("full_name") or "Entreprise"
            user = CustomUser.objects.create(username=username, is_confirmed=True, **validated_data)
            user.set_password(password)
            user.save()
            AdminProfile.objects.create(user=user, company_name=company_name)
            return user
        elif role == "magasin":
            try:
                admin = CustomUser.objects.get(email=admin_email, role="admin")
            except CustomUser.DoesNotExist:
                raise serializers.ValidationError({"admin_email": "Administrateur introuvable avec cet email."})
            user = CustomUser.objects.create(username=username, is_confirmed=False, **validated_data)
            user.set_password(password)
            user.save()
            MagasinProfile.objects.create(user=user, admin=admin, shop_name=shop_name)
            return user
        elif role == "employer":
            admin = CustomUser.objects.filter(email=admin_email, role="admin").first()
            magasin = None
            if not admin:
                magasin_user = CustomUser.objects.filter(email=admin_email, role="magasin").first()
                if magasin_user:
                    magasin = MagasinProfile.objects.get(user=magasin_user)
            if not admin and not magasin:
                raise serializers.ValidationError({"admin_email": "Responsable (administrateur ou gérant) introuvable avec cet email."})
            user = CustomUser.objects.create(username=username, is_confirmed=False, **validated_data)
            user.set_password(password)
            user.save()
            EmployerProfile.objects.create(user=user, admin=admin, magasin=magasin, position=position)
            return user
        raise serializers.ValidationError("Role invalide")

class ProductVariantSerializer(serializers.ModelSerializer):
    class Meta:
        model = ProductVariant
        fields = ['id', 'size', 'color', 'quantity']


class ProductSerializer(serializers.ModelSerializer):
    shop_name = serializers.CharField(source='magasin.shop_name', read_only=True)
    variants = ProductVariantSerializer(many=True, read_only=True)

    class Meta:
        model = Product
        fields = "__all__"

    def to_representation(self, instance):
        representation = super().to_representation(instance)
        request = self.context.get("request")
        # Hide purchase price (unit_price) to magasin and employer roles
        if request and request.user and getattr(request.user, "role", None) != "admin":
            representation.pop("unit_price", None)
            representation.pop("purchase_price", None)
        return representation

class SaleSerializer(serializers.ModelSerializer):
    seller_name = serializers.CharField(source="seller.full_name", read_only=True)
    shop_name = serializers.CharField(source="magasin.shop_name", read_only=True)
    product_name = serializers.CharField(source="product.name", read_only=True)
    profit_per_unit = serializers.SerializerMethodField(read_only=True)
    total_profit = serializers.SerializerMethodField(read_only=True)

    class Meta:
        model = Sale
        fields = [
            "id",
            "product",
            "product_name",
            "magasin",
            "shop_name",
            "seller",
            "seller_name",
            "quantity",
            "sale_price",
            "payment_amount",
            "payment_date",
            "payment_due_date",
            "customer_name",
            "is_paid",
            "total_price",
            "profit_per_unit",
            "total_profit",
            "sold_at",
        ]

    def validate(self, attrs):
        product = attrs.get("product")
        quantity = attrs.get("quantity")
        if product and quantity:
            if product.initial_quantity < quantity:
                raise serializers.ValidationError(
                    {"quantity": f"Quantité en stock insuffisante. Stock disponible : {product.initial_quantity}."}
                )
        return attrs

    def get_profit_per_unit(self, obj):
        return obj.profit_per_unit

    def get_total_profit(self, obj):
        return obj.total_profit


class MovementSerializer(serializers.ModelSerializer):
    product_name = serializers.SerializerMethodField(read_only=True)
    product_reference = serializers.CharField(source="product.reference", read_only=True)
    magasin_name = serializers.CharField(source="magasin.shop_name", read_only=True)
    changed_by_name = serializers.CharField(source="changed_by.full_name", read_only=True)
    movement_type = serializers.SerializerMethodField(read_only=True)

    class Meta:
        model = Movement
        fields = [
            "id",
            "product",
            "product_name",
            "product_reference",
            "magasin",
            "magasin_name",
            "changed_by",
            "changed_by_name",
            "previous_quantity",
            "new_quantity",
            "change",
            "previous_unit_price",
            "new_unit_price",
            "previous_shell_price",
            "new_shell_price",
            "movement_type",
            "note",
            "created_at",
        ]
        read_only_fields = [
            "id",
            "created_at",
            "movement_type",
            "product_name",
            "product_reference",
            "magasin_name",
            "changed_by_name",
        ]

    def get_product_name(self, obj):
        return obj.product_name or (obj.product.name if obj.product else None)

    def get_movement_type(self, obj):
        return obj.movement_type


class NotificationSerializer(serializers.ModelSerializer):
    magasin_name = serializers.CharField(source="magasin.shop_name", read_only=True)
    product_name = serializers.CharField(source="product.name", read_only=True)
    sale_id = serializers.IntegerField(source="sale.id", read_only=True)
    user_name = serializers.CharField(source="user.full_name", read_only=True)

    class Meta:
        model = Notification
        fields = ["id", "notif_type", "message", "magasin", "magasin_name", "product", "product_name", "sale", "sale_id", "user", "user_name", "is_read", "created_at"]
        read_only_fields = ["id", "created_at"]


class MagasinProfileSerializer(serializers.ModelSerializer):
    shop_logo = serializers.SerializerMethodField()

    class Meta:
        model = MagasinProfile
        fields = ["id", "shop_name", "description", "shop_logo", "admin", "user"]
        read_only_fields = ["id", "admin", "user"]

    def get_shop_logo(self, obj):
        request = self.context.get('request')
        if obj.shop_logo and request:
            return request.build_absolute_uri(obj.shop_logo.url)
        return None


class ChatMessageSerializer(serializers.ModelSerializer):
    sender_name = serializers.CharField(source="sender.full_name", read_only=True)
    sender_email = serializers.CharField(source="sender.email", read_only=True)
    sender_role = serializers.CharField(source="sender.role", read_only=True)
    recipient_name = serializers.CharField(source="recipient.full_name", read_only=True)
    recipient_email = serializers.CharField(source="recipient.email", read_only=True)

    class Meta:
        model = ChatMessage
        fields = [
            "id",
            "sender",
            "sender_name",
            "sender_email",
            "sender_role",
            "recipient",
            "recipient_name",
            "recipient_email",
            "room_name",
            "content",
            "timestamp",
        ]
        read_only_fields = ["id", "timestamp"]
