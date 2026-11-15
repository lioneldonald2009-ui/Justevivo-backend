# Campagne JUSTEVIVO — novembre/décembre 2026

Le backend applique automatiquement le code Dodo `JUSTEVIVO30` aux sessions de paiement éligibles, du 16 novembre 2026 au 31 décembre 2026 inclus (UTC). Le code est transmis uniquement par le serveur, jamais par le navigateur.

## Configuration requise dans Dodo Payments

Dans le même environnement que celui utilisé par Render (test ou live), créer un code de réduction avec ces paramètres exacts :

- Code : `JUSTEVIVO30`
- Type : pourcentage
- Valeur : 30 %
- Nombre maximal d'utilisations : 60
- Nombre de cycles d'abonnement : 1 (premier paiement mensuel uniquement)
- Début : 16 novembre 2026 à 00:00 UTC
- Expiration : 1 janvier 2027 à 00:00 UTC (fin du 31 décembre)
- Produits autorisés : les trois produits mensuels Starter, Pro et Business de JUSTEVIVO
- Éligibilité client : tous les clients

Le code doit être créé dans l'environnement Dodo réellement utilisé par Render. Ne pas créer un code test si Render est en live, ni l'inverse.

Le backend suppose le code `JUSTEVIVO30` par défaut. Pour utiliser un autre code, définir la variable Render `DODO_PROMO_CODE` avec ce code, puis redéployer.

## Compteur

La table Supabase `jv_promo_claims` conserve une ligne par utilisateur et campagne. Une place est comptée uniquement à la réception du webhook signé `subscription.active` avec la métadonnée de campagne. Les tentatives de paiement et les comptes gratuits ne sont pas comptés. La contrainte unique empêche de compter deux fois le même utilisateur.

Endpoint public : `GET /api/promotions/nov-dec-2026`.

Le compteur du site est indicatif ; la limite de 60 utilisations configurée directement dans Dodo est l'autorité finale qui empêche toute utilisation au-delà du quota. La réduction ne concerne que le premier cycle ; les renouvellements reviennent au tarif normal.
