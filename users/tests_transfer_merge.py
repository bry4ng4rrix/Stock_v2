"""Transferts inter-magasins : fusion des fiches produit identiques.

L'IA est désactivée dans ces tests (`AI_PRODUCT_MATCHING_ENABLED=False`) : on y
vérifie les règles déterministes et le comportement de fusion, qui doivent tenir
seuls — c'est précisément le chemin emprunté quand Ollama est indisponible.
"""

from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import override_settings
from rest_framework import status
from rest_framework.test import APITestCase

from users.models import MagasinProfile, Movement, Product, ProductVariant, Sale

User = get_user_model()


@override_settings(AI_PRODUCT_MATCHING_ENABLED=False)
class TransferMergeAPITestCase(APITestCase):

    def setUp(self):
        self.admin = User.objects.create_user(
            email="owner@test.com",
            password="testpassword123",
            role="admin",
            is_confirmed=True,
            full_name="Owner",
        )
        self.source = MagasinProfile.objects.create(admin=self.admin, shop_name="Boutique A")
        self.source.admins.add(self.admin)
        self.dest = MagasinProfile.objects.create(admin=self.admin, shop_name="Boutique B")
        self.dest.admins.add(self.admin)
        self.client.force_authenticate(user=self.admin)

    def _product(self, magasin, name="Strasse", reference="AB-200", quantity=10,
                 unit_price="150000", shell_price="200000", description="Robe longue"):
        # Decimal et non str : en production les prix arrivent désérialisés par
        # DRF, et Sale.save() fait de l'arithmétique dessus.
        return Product.objects.create(
            name=name,
            reference=reference,
            category="Vetements",
            description=description,
            unit_price=Decimal(unit_price),
            shell_price=Decimal(shell_price),
            initial_quantity=quantity,
            alert_threshold=1,
            magasin=magasin,
        )

    def _transfer(self, product, quantity=None):
        payload = {
            "source_magasin_id": self.source.id,
            "destination_magasin_id": self.dest.id,
            "items": [{"product_id": product.id, "quantity": quantity}],
        }
        return self.client.post("/api/users/transfer/products/", payload, format="json")

    # --- fusion ---------------------------------------------------------

    def test_partial_transfer_merges_into_identical_sheet(self):
        source_product = self._product(self.source, quantity=10)
        dest_product = self._product(self.dest, quantity=4, reference="AB-200-TR9")

        response = self._transfer(source_product, quantity=6)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["merged_count"], 1)
        self.assertEqual(response.data["created_count"], 0)
        dest_product.refresh_from_db()
        source_product.refresh_from_db()
        self.assertEqual(dest_product.initial_quantity, 10)
        self.assertEqual(source_product.initial_quantity, 4)
        self.assertEqual(Product.objects.filter(magasin=self.dest).count(), 1)

    def test_full_transfer_merges_instead_of_creating_a_duplicate(self):
        """Le trajet qui produisait le plus de doublons : tout le stock part."""
        source_product = self._product(self.source, quantity=10)
        dest_product = self._product(self.dest, quantity=4, reference="AB-200-TR9")

        response = self._transfer(source_product, quantity=10)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["merged_count"], 1)
        dest_product.refresh_from_db()
        source_product.refresh_from_db()
        self.assertEqual(dest_product.initial_quantity, 14)
        # La fiche source est vidée mais conservée dans son magasin d'origine.
        self.assertEqual(source_product.initial_quantity, 0)
        self.assertEqual(source_product.magasin_id, self.source.id)
        self.assertEqual(Product.objects.filter(magasin=self.dest).count(), 1)

    def test_case_and_accent_differences_still_merge(self):
        source_product = self._product(self.source, name="Élégance Été", reference="AB-200")
        dest_product = self._product(self.dest, name="elegance ete", reference="ab-200", quantity=2)

        self._transfer(source_product, quantity=5)

        dest_product.refresh_from_db()
        self.assertEqual(dest_product.initial_quantity, 7)

    # --- non-fusion -----------------------------------------------------

    def test_different_price_never_merges(self):
        source_product = self._product(self.source, quantity=10)
        self._product(self.dest, quantity=4, shell_price="180000")  # prix de vente different

        response = self._transfer(source_product, quantity=6)

        self.assertEqual(response.data["merged_count"], 0)
        self.assertEqual(response.data["created_count"], 1)
        self.assertEqual(Product.objects.filter(magasin=self.dest).count(), 2)

    def test_different_reference_does_not_merge_without_ai(self):
        source_product = self._product(self.source, quantity=10)
        self._product(self.dest, reference="ZZ-999", quantity=4)

        response = self._transfer(source_product, quantity=6)

        self.assertEqual(response.data["merged_count"], 0)
        self.assertEqual(Product.objects.filter(magasin=self.dest).count(), 2)

    # --- historique -----------------------------------------------------

    def test_full_transfer_merge_preserves_sales_history(self):
        source_product = self._product(self.source, quantity=10)
        self._product(self.dest, quantity=4, reference="AB-200-TR9")
        sale = Sale.objects.create(
            product=source_product,
            magasin=self.source,
            seller=self.admin,
            quantity=1,
            sale_price=Decimal("200000"),
        )

        self._transfer(source_product, quantity=10)

        sale.refresh_from_db()
        self.assertEqual(sale.product_id, source_product.id)
        self.assertTrue(Product.objects.filter(id=source_product.id).exists())

    def test_full_transfer_merge_records_both_movements(self):
        source_product = self._product(self.source, quantity=10)
        self._product(self.dest, quantity=4, reference="AB-200-TR9")

        self._transfer(source_product, quantity=10)

        batch = Movement.objects.exclude(transfer_batch=None).values_list("transfer_batch", flat=True).first()
        movements = Movement.objects.filter(transfer_batch=batch)
        self.assertEqual(movements.count(), 2)
        self.assertEqual(sorted(m.change for m in movements), [-10, 10])

    # --- variantes ------------------------------------------------------

    def test_variants_are_merged_on_full_transfer(self):
        source_product = self._product(self.source, quantity=0)
        ProductVariant.objects.create(product=source_product, size="38", color="Rouge", quantity=5)
        ProductVariant.objects.create(product=source_product, size="40", color="Noir", quantity=3)
        source_product.initial_quantity = 8
        source_product.save()

        dest_product = self._product(self.dest, quantity=0, reference="AB-200-TR9")
        ProductVariant.objects.create(product=dest_product, size="38", color="Rouge", quantity=2)
        dest_product.initial_quantity = 2
        dest_product.save()

        self._transfer(source_product, quantity=8)

        dest_product.refresh_from_db()
        self.assertEqual(dest_product.initial_quantity, 10)
        # La 38/Rouge est cumulée, la 40/Noir recréée : deux variantes, pas trois.
        self.assertEqual(ProductVariant.objects.filter(product=dest_product).count(), 2)
        red = ProductVariant.objects.get(product=dest_product, size="38", color="Rouge")
        self.assertEqual(red.quantity, 7)
        # Les variantes source sont vidées, jamais supprimées (Sale.variant).
        self.assertEqual(ProductVariant.objects.filter(product=source_product).count(), 2)
        self.assertEqual(
            sum(v.quantity for v in ProductVariant.objects.filter(product=source_product)), 0
        )
