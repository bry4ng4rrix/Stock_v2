"""Assistant conversationnel : boucle agent, périmètre, confirmation signée.

Le modèle est simulé (`_call_model` patché) : on vérifie ici le contrat autour
d'Ollama, pas Ollama lui-même — le service réel n'est disponible que sur le VPS.
"""

import io
from decimal import Decimal
from http import client as http_client
from unittest.mock import patch
from urllib import error as urllib_error

from django.contrib.auth import get_user_model
from django.core import signing
from rest_framework.test import APITestCase

from users import assistant
from users.models import EmployerProfile, MagasinProfile, Movement, Product

User = get_user_model()


def _model_reply(content="", tool_calls=None):
    message = {"role": "assistant", "content": content}
    if tool_calls:
        message["tool_calls"] = [
            {"function": {"name": name, "arguments": arguments}} for name, arguments in tool_calls
        ]
    return {"message": message}


class AssistantAPITestCase(APITestCase):

    def setUp(self):
        self.admin = User.objects.create_user(
            email="owner@test.com", password="x", role="admin", is_confirmed=True, full_name="Owner"
        )
        self.store = MagasinProfile.objects.create(admin=self.admin, shop_name="Boutique A")
        self.store.admins.add(self.admin)
        self.other_store = MagasinProfile.objects.create(admin=self.admin, shop_name="Boutique B")
        self.other_store.admins.add(self.admin)
        self.product = Product.objects.create(
            name="Strasse", reference="AB-200", category="Vetements",
            unit_price=Decimal("150000"), shell_price=Decimal("200000"),
            initial_quantity=14, alert_threshold=2, magasin=self.store,
        )
        self.employee = User.objects.create_user(
            email="emp@test.com", password="x", role="employer", is_confirmed=True, full_name="Emp"
        )
        EmployerProfile.objects.create(user=self.employee, admin=self.admin, magasin=self.store, position="Vendeur")

    # --- lecture -------------------------------------------------------

    def test_read_tool_is_executed_and_answer_returned(self):
        self.client.force_authenticate(user=self.admin)
        replies = [
            _model_reply(tool_calls=[("search_products", {"query": "strasse"})]),
            _model_reply(content="Strasse : 14 unités en stock à 200000 Ar."),
        ]
        with patch.object(assistant, "_call_model", side_effect=replies) as mocked:
            response = self.client.post(
                "/api/users/assistant/chat/",
                {"messages": [{"role": "user", "content": "combien de strasse ?"}]},
                format="json",
            )
        self.assertEqual(response.status_code, 200)
        self.assertIn("14", response.data["reply"])
        self.assertEqual(response.data["actions"][0]["tool"], "search_products")
        self.assertEqual(response.data["actions"][0]["result"]["produits"][0]["stock"], 14)
        self.assertEqual(response.data["pending_actions"], [])
        # Le résultat de l'outil a bien été renvoyé au modèle au 2e appel.
        second_call_messages = mocked.call_args_list[1].args[0]
        self.assertEqual(second_call_messages[-1]["role"], "tool")

    def test_employee_gets_no_mutation_tools(self):
        tools = {t["function"]["name"] for t in assistant.tool_definitions(self.employee)}
        self.assertIn("search_products", tools)
        self.assertNotIn("adjust_stock", tools)

    def test_scope_is_limited_to_accessible_stores(self):
        stranger = User.objects.create_user(
            email="other@test.com", password="x", role="admin", is_confirmed=True, full_name="Other"
        )
        result = assistant.tool_search_products(stranger, query="strasse")
        self.assertEqual(result["total"], 0)

    # --- modification : prévisualisation puis confirmation ---------------

    def test_mutation_is_not_executed_without_confirmation(self):
        self.client.force_authenticate(user=self.admin)
        replies = [_model_reply(tool_calls=[("adjust_stock", {"product_id": self.product.id, "change": 5, "raison": "réception"})])]
        with patch.object(assistant, "_call_model", side_effect=replies):
            response = self.client.post(
                "/api/users/assistant/chat/",
                {"messages": [{"role": "user", "content": "ajoute 5 strasse"}]},
                format="json",
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data["pending_actions"]), 1)
        pending = response.data["pending_actions"][0]
        self.assertEqual(pending["tool"], "adjust_stock")
        self.assertIn("14 → 19", pending["description"])
        self.product.refresh_from_db()
        self.assertEqual(self.product.initial_quantity, 14)
        self.assertEqual(Movement.objects.count(), 0)
        self.token = pending["token"]

        # Confirmation : exécution + trace dans les mouvements.
        response = self.client.post("/api/users/assistant/execute/", {"token": pending["token"]}, format="json")
        self.assertEqual(response.status_code, 200)
        self.product.refresh_from_db()
        self.assertEqual(self.product.initial_quantity, 19)
        movement = Movement.objects.get()
        self.assertEqual(movement.change, 5)
        self.assertEqual(movement.changed_by, self.admin)
        self.assertTrue(movement.note.startswith(assistant.NOTE_PREFIX))
        self.assertIn("réception", movement.note)

    def test_token_cannot_be_replayed_by_another_user(self):
        token = assistant._sign_action(self.admin, "adjust_stock", {"product_id": self.product.id, "change": 1, "raison": "", "variant_id": None}, "x")
        other_admin = User.objects.create_user(
            email="other@test.com", password="x", role="admin", is_confirmed=True, full_name="Other"
        )
        self.client.force_authenticate(user=other_admin)
        response = self.client.post("/api/users/assistant/execute/", {"token": token}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Movement.objects.count(), 0)

    def test_tampered_token_is_rejected(self):
        self.client.force_authenticate(user=self.admin)
        response = self.client.post("/api/users/assistant/execute/", {"token": "abc.def.ghi"}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_execution_revalidates_current_stock(self):
        """Le stock a pu bouger entre la prévisualisation et la confirmation."""
        token = assistant._sign_action(self.admin, "adjust_stock", {"product_id": self.product.id, "change": -14, "raison": "", "variant_id": None}, "x")
        self.product.initial_quantity = 3
        self.product.save()
        self.client.force_authenticate(user=self.admin)
        response = self.client.post("/api/users/assistant/execute/", {"token": token}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("insuffisant", response.data["error"])

    def test_price_update_records_movement_with_prices(self):
        self.client.force_authenticate(user=self.admin)
        preview = assistant.preview_update_prices(self.admin, self.product.id, prix_vente=210000)
        token = assistant._sign_action(self.admin, "update_prices", preview["arguments"], preview["description"])
        response = self.client.post("/api/users/assistant/execute/", {"token": token}, format="json")
        self.assertEqual(response.status_code, 200)
        movement = Movement.objects.get()
        self.assertEqual(movement.previous_shell_price, Decimal("200000"))
        self.assertEqual(movement.new_shell_price, Decimal("210000"))
        self.assertEqual(movement.movement_type, "Mise à jour")

    def test_transfer_goes_through_transfer_view_and_logs_movements(self):
        self.client.force_authenticate(user=self.admin)
        preview = assistant.preview_transfer_product(
            self.admin, self.product.id, self.other_store.id, quantite=4
        )
        token = assistant._sign_action(self.admin, "transfer_product", preview["arguments"], preview["description"])
        with self.settings(AI_PRODUCT_MATCHING_ENABLED=False):
            response = self.client.post("/api/users/assistant/execute/", {"token": token}, format="json")
        self.assertEqual(response.status_code, 200)
        self.product.refresh_from_db()
        self.assertEqual(self.product.initial_quantity, 10)
        self.assertEqual(Product.objects.get(magasin=self.other_store).initial_quantity, 4)
        self.assertEqual(Movement.objects.filter(note__icontains="transfert").count(), 2)

    def test_employee_cannot_execute_even_with_valid_token(self):
        token = assistant._sign_action(self.employee, "adjust_stock", {"product_id": self.product.id, "change": 1, "raison": "", "variant_id": None}, "x")
        self.client.force_authenticate(user=self.employee)
        response = self.client.post("/api/users/assistant/execute/", {"token": token}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_ollama_down_returns_503(self):
        self.client.force_authenticate(user=self.admin)
        with patch.object(assistant, "_call_model", side_effect=assistant.AssistantUnavailable("down")):
            response = self.client.post(
                "/api/users/assistant/chat/",
                {"messages": [{"role": "user", "content": "bonjour"}]},
                format="json",
            )
        self.assertEqual(response.status_code, 503)

    # --- pannes Ollama --------------------------------------------------
    # Chaque cause de panne doit être reconnaissable dans la réponse : c'est
    # ce qui évite, sur le VPS, de chercher un problème réseau quand il
    # manque de la RAM, ou l'inverse.

    def _chat_with_ollama_failing(self, side_effect):
        self.client.force_authenticate(user=self.admin)
        with patch.object(assistant, "_ollama_chat", side_effect=side_effect):
            return self.client.post(
                "/api/users/assistant/chat/",
                {"messages": [{"role": "user", "content": "bonjour"}]},
                format="json",
            )

    @staticmethod
    def _http_error(code, body):
        return urllib_error.HTTPError("http://ollama/api/chat", code, "err", {}, io.BytesIO(body.encode()))

    def test_ollama_oom_kill_is_reported_as_memory(self):
        # Corps réel renvoyé par Ollama quand le runner est tué par l'OOM killer.
        response = self._chat_with_ollama_failing(
            self._http_error(500, '{"error":"llama-server process has terminated: signal: killed"}')
        )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.data["reason"], "memory")
        self.assertEqual(response.data["error"], assistant.AssistantUnavailable.MEMORY)

    def test_ollama_dying_mid_request_is_reported_as_crash(self):
        response = self._chat_with_ollama_failing(
            http_client.RemoteDisconnected("Remote end closed connection without response")
        )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.data["reason"], "crash")
        self.assertEqual(response.data["error"], assistant.AssistantUnavailable.MEMORY)

    def test_ollama_read_timeout_is_reported_as_timeout(self):
        response = self._chat_with_ollama_failing(TimeoutError("timed out"))
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.data["reason"], "timeout")

    def test_ollama_connection_refused_is_reported_as_unreachable(self):
        response = self._chat_with_ollama_failing(urllib_error.URLError(ConnectionRefusedError(111, "refused")))
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.data["reason"], "unreachable")
        self.assertEqual(response.data["error"], assistant.AssistantUnavailable.UNREACHABLE)

    def test_missing_model_is_reported_as_such(self):
        response = self._chat_with_ollama_failing(self._http_error(404, '{"error":"model \'x\' not found"}'))
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.data["reason"], "model_missing")

    def test_http_400_retries_once_without_think(self):
        # Un Ollama trop ancien refuse le champ `think` : on le retire et on rejoue.
        calls = []

        def fake_chat(body, timeout):
            calls.append(dict(body))
            if "think" in body:
                raise self._http_error(400, '{"error":"unknown field think"}')
            return _model_reply(content="Bonjour !")

        self.client.force_authenticate(user=self.admin)
        with patch.object(assistant, "_ollama_chat", side_effect=fake_chat):
            response = self.client.post(
                "/api/users/assistant/chat/",
                {"messages": [{"role": "user", "content": "bonjour"}]},
                format="json",
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(calls), 2)
        self.assertIn("think", calls[0])
        self.assertNotIn("think", calls[1])

    def test_thinking_block_is_stripped_from_reply(self):
        self.client.force_authenticate(user=self.admin)
        reply = _model_reply(content="<think>\nL'utilisateur salue.\n</think>\n\nBonjour ! Que puis-je faire ?")
        with patch.object(assistant, "_call_model", return_value=reply):
            response = self.client.post(
                "/api/users/assistant/chat/",
                {"messages": [{"role": "user", "content": "bonjour"}]},
                format="json",
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["reply"], "Bonjour ! Que puis-je faire ?")

    def test_markdown_bold_and_euro_are_cleaned_from_reply(self):
        # qwen2.5:0.5b ignore « pas de markdown » et « montants en ariary ».
        self.client.force_authenticate(user=self.admin)
        reply = _model_reply(content="- **Strasse** : 14 unités, valeur 200000.0€.")
        with patch.object(assistant, "_call_model", return_value=reply):
            response = self.client.post(
                "/api/users/assistant/chat/",
                {"messages": [{"role": "user", "content": "stock ?"}]},
                format="json",
            )
        self.assertEqual(response.data["reply"], "- Strasse : 14 unités, valeur 200000.0Ar.")
