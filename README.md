# JUSTEVIVO — Backend Render

Le serveur Express conserve les routes, les noms des variables d'environnement, l'intégration Supabase, Groq et FedaPay existantes. Un endpoint `GET /health` est ajouté pour le contrôle de disponibilité, ainsi que des en-têtes HTTP de sécurité simples.

Le déploiement doit conserver le service Render existant, sa branche, son Root Directory et toutes ses variables d'environnement. Déployer le contenu de ce dossier dans le dépôt backend déjà connecté à Render.

Aucune migration SQL n'est incluse : le schéma et les politiques Supabase existants ne doivent pas être modifiés sans audit préalable.


## Génération vidéo IA — activation contrôlée

Les routes de génération sont disponibles, mais restent désactivées fonctionnellement tant que les deux conditions suivantes ne sont pas réunies :

1. Configurer un fournisseur dans Render : `LTX_API_KEY` (prioritaire) ou `RUNWAYML_API_SECRET`.
2. Attribuer explicitement les crédits mensuels par formule dans Render :
   - `JV_AI_CREDITS_FREE`
   - `JV_AI_CREDITS_STARTER`
   - `JV_AI_CREDITS_PRO`
   - `JV_AI_CREDITS_BUSINESS`
   - `JV_AI_CREDITS_ALL_IN_ONE`

Toutes les valeurs de crédits sont à 0 par défaut. Ne les augmentez qu'après avoir défini le prix des abonnements, le coût réel du fournisseur, la marge et les plafonds anti-abus. Les clés API restent exclusivement dans les variables d'environnement Render. Les générations échouées font l'objet d'un remboursement de crédits lorsque le fournisseur confirme l'échec.

Le endpoint `GET /api/ai-video/config` indique maintenant séparément l'absence de fournisseur et l'absence de crédits. L'interface désactive le bouton de génération tant que le service n'est pas réellement disponible.
