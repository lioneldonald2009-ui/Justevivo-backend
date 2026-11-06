# JUSTEVIVO — Backend Render

Le serveur Express conserve les routes, les noms des variables d'environnement, l'intégration Supabase, Groq et FedaPay existantes. Un endpoint `GET /health` est ajouté pour le contrôle de disponibilité, ainsi que des en-têtes HTTP de sécurité simples.

Le déploiement doit conserver le service Render existant, sa branche, son Root Directory et toutes ses variables d'environnement. Déployer le contenu de ce dossier dans le dépôt backend déjà connecté à Render.

Aucune migration SQL n'est incluse : le schéma et les politiques Supabase existants ne doivent pas être modifiés sans audit préalable.
