"""Guide d'utilisation exposé à l'assistant.

Deux choses sont vérifiées ici : que le guide chargé correspond bien à celui
affiché par la page /aide (mêmes sections, mêmes droits), et que la recherche
renvoie la bonne section pour les formulations que les utilisateurs emploient
réellement — « comment vendre » plutôt que « vente ».
"""

import json
from pathlib import Path
from unittest.mock import patch

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from users import assistant, guide
from users.models import EmployerProfile, MagasinProfile

User = get_user_model()

GUIDE_TS = (
    Path(__file__).resolve().parent.parent
    / "frontend" / "app" / "(app)" / "aide" / "guide-content.ts"
)


class GuideContentTests(APITestCase):

    def test_json_is_in_sync_with_the_typescript_source(self):
        """Le JSON est généré depuis le .ts par scripts/export_guide.ts.

        Si quelqu'un corrige le guide côté frontend sans relancer le script,
        l'assistant continue de répondre l'ancien texte — silencieusement.
        On compare les identifiants de section, qui suffisent à détecter un
        ajout ou une suppression.
        """
        if not GUIDE_TS.exists():  # frontend absent (image backend seule)
            self.skipTest("Source TypeScript du guide non disponible")
        source = GUIDE_TS.read_text(encoding="utf-8")
        ids_ts = {line.split("'")[1] for line in source.splitlines() if line.strip().startswith("id: '")}
        ids_json = {section["id"] for section in guide._guide()["sections"]}
        self.assertEqual(
            ids_ts, ids_json,
            "guide_content.json est désynchronisé : relancer "
            "`node --experimental-strip-types scripts/export_guide.ts`",
        )

    def test_sections_are_filtered_by_role(self):
        admin = {s["id"] for s in guide.sections_for_role("admin")}
        employer = {s["id"] for s in guide.sections_for_role("employer")}
        self.assertIn("transferts", admin)
        # Un employé n'a pas l'écran Transferts : lui en décrire la procédure
        # l'enverrait chercher un bouton qu'il n'a pas.
        self.assertNotIn("transferts", employer)
        self.assertTrue(employer.issubset(admin))

    def test_unknown_role_gets_nothing_rather_than_everything(self):
        self.assertEqual(guide.sections_for_role(None), [])
        self.assertEqual(guide.lookup(None, "caisse"), {"erreur": "Guide indisponible."})

    def test_prompt_index_stays_small_enough_for_the_system_prompt(self):
        """Le modèle tourne sur CPU : l'index est dans chaque prompt, il doit
        rester un sommaire. Le guide entier fait ~19 000 caractères."""
        index = guide.prompt_index("admin")
        self.assertLess(len(index), 3000)
        self.assertEqual(len(index.splitlines()), len(guide.sections_for_role("admin")))

    def test_common_questions_reach_the_right_section(self):
        cas = [
            ("magasin", "comment creer un produit", "produits"),
            ("magasin", "comment ajouter du stock", "produits"),
            ("magasin", "ouvrir la caisse", "caisse"),
            ("magasin", "fermer la caisse", "caisse"),
            ("admin", "comment transferer un produit", "transferts"),
            ("employer", "comment vendre", "ventes"),
            ("magasin", "variante taille couleur", "produits"),
            ("magasin", "import excel", "produits"),
            ("admin", "abonnement", "equipe"),
            ("admin", "sauvegarder mes donnees", "sauvegarde"),
            ("employer", "scanner un qr code", "scanner"),
        ]
        for role, question, attendu in cas:
            with self.subTest(question=question):
                self.assertIn(attendu, guide.lookup(role, question).get("sections", []))

    def test_off_topic_question_returns_no_section(self):
        result = guide.lookup("admin", "recette de cuisine malgache")
        self.assertNotIn("sections", result)
        self.assertIn("sections_disponibles", result)

    def test_lookup_by_section_id(self):
        result = guide.lookup("admin", section_id="caisse")
        self.assertEqual(result["sections"], ["caisse"])
        self.assertIn("Caisse", result["texte"])

    def test_answer_is_capped(self):
        """Une réponse d'outil trop longue fait exploser le temps de traitement
        du prompt au tour suivant."""
        for role, question in [("admin", "stock"), ("admin", "magasin"), ("admin", "produit")]:
            with self.subTest(question=question):
                result = guide.lookup(role, question)
                self.assertLessEqual(len(result.get("texte", "")), guide.MAX_CHARS)
                self.assertLessEqual(len(result.get("sections", [])), guide.MAX_SECTIONS)

    def test_missing_guide_file_does_not_break_the_assistant(self):
        guide._guide.cache_clear()
        try:
            with patch.object(guide, "GUIDE_PATH", Path("/inexistant/guide.json")):
                self.assertEqual(guide.sections_for_role("admin"), [])
                self.assertEqual(guide.prompt_index("admin"), "")
        finally:
            guide._guide.cache_clear()


class GuideToolTests(APITestCase):

    def setUp(self):
        self.admin = User.objects.create_user(
            email="owner@test.com", password="x", role="admin", is_confirmed=True, full_name="Owner"
        )
        self.store = MagasinProfile.objects.create(admin=self.admin, shop_name="Boutique A")
        self.store.admins.add(self.admin)
        self.employee = User.objects.create_user(
            email="emp@test.com", password="x", role="employer", is_confirmed=True, full_name="Emp"
        )
        EmployerProfile.objects.create(user=self.employee, admin=self.admin, magasin=self.store, position="Vendeur")

    def test_guide_tool_is_offered_to_every_role(self):
        for user in (self.admin, self.employee):
            names = [t["function"]["name"] for t in assistant.tool_definitions(user)]
            self.assertIn("guide_app", names)

    def test_system_prompt_carries_the_index_not_the_whole_guide(self):
        prompt = assistant._system_prompt(self.admin, assistant.accessible_magasins(self.admin), None)
        self.assertIn("guide_app", prompt)
        self.assertIn("Transferts entre magasins", prompt)   # titre, présent dans l'index
        self.assertNotIn("Réapprovisionner", prompt)          # détail, réservé à l'outil

    def test_employee_prompt_hides_admin_sections(self):
        prompt = assistant._system_prompt(self.employee, assistant.accessible_magasins(self.employee), None)
        self.assertNotIn("Transferts entre magasins", prompt)

    def test_guide_tool_runs_through_the_agent_loop(self):
        """Le modèle demande guide_app, le résultat revient dans `actions`."""
        self.client.force_authenticate(user=self.admin)
        replies = [
            {"message": {"role": "assistant", "content": "",
                         "tool_calls": [{"function": {"name": "guide_app", "arguments": {"sujet": "ouvrir la caisse"}}}]}},
            {"message": {"role": "assistant", "content": "Allez sur Caisse puis « Ouvrir la caisse »."}},
        ]
        with patch.object(assistant, "_call_model", side_effect=replies):
            response = self.client.post(
                "/api/users/assistant/chat/",
                {"messages": [{"role": "user", "content": "comment ouvrir la caisse ?"}]},
                format="json",
            )
        self.assertEqual(response.status_code, 200)
        actions = response.data["actions"]
        self.assertEqual(actions[0]["tool"], "guide_app")
        self.assertIn("caisse", actions[0]["result"]["sections"])
        self.assertIn("Ouvrir", actions[0]["result"]["texte"])

    def test_tool_result_is_json_serialisable(self):
        """La boucle sérialise le résultat pour le renvoyer au modèle."""
        result = assistant.tool_guide_app(self.admin, sujet="variantes")
        json.dumps(result, ensure_ascii=False)
        self.assertIn("produits", result["sections"])
