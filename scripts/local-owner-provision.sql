-- ============================================================================
-- Local one-click stack: provision the Shodasha owner account.
-- One-shot, idempotent, LOCAL DEV ONLY (this database holds seeded demo orgs
-- with published passwords; never run against anything reachable by others).
--
--   docker exec -i warmbly-postgres-1 psql -U warmbly -d warmbly_dev \
--     < scripts/local-owner-provision.sql
--
--   Email:    adityathakur452007@gmail.com   (owner, org: Shodasha Cold Emails)
--   Password: Shodasha@2026
-- ============================================================================

-- 1. The owner user. ON CONFLICT keeps an existing account untouched.
INSERT INTO users (id, first_name, last_name, email, password_hash, onboarding_completed_at)
VALUES (
    '11111111-0000-0000-0000-00000000a001',
    'Aaditya', 'Thakur',
    'adityathakur452007@gmail.com',
    '$argon2id$v=19$m=65536,t=3,p=2$nzsFCl9joYqsDvfWMuCEVA$4qyGmBxX6DXp0Wh0sFSoVocAtuoO95D/jBZVe3Xk+GY',
    NOW()
)
ON CONFLICT (id) DO NOTHING;

-- In case the email already existed under a different id, adopt that row
-- instead of failing the unique constraint.
UPDATE users SET password_hash =
    '$argon2id$v=19$m=65536,t=3,p=2$nzsFCl9joYqsDvfWMuCEVA$4qyGmBxX6DXp0Wh0sFSoVocAtuoO95D/jBZVe3Xk+GY',
    onboarding_completed_at = COALESCE(onboarding_completed_at, NOW())
WHERE email = 'adityathakur452007@gmail.com';

-- 2. Owner of the existing Shodasha Cold Emails org (id 22222222-...-01).
INSERT INTO organization_members (organization_id, user_id, role, permissions, accepted_at)
VALUES ('22222222-0000-0000-0000-000000000001',
        (SELECT id FROM users WHERE email = 'adityathakur452007@gmail.com'),
        'owner', 0, NOW())
ON CONFLICT DO NOTHING;

-- 3. Deactivate every seed/demo mailbox. These are fixture rows
--    (smtp.test.local, Gmail accounts with revoked OAuth grants,
--    hex-corrupted credentials) whose dead credentials made the worker
--    reconciler log-spam every few seconds. 'inactive' is the enum value the
--    backend itself sets on dead credentials (event_email_error.go), and it
--    removes the row from ListActiveWorkerAccounts: no more sync errors, no
--    more 404/500 reconciler spam. Reconnect a mailbox from Settings > Emails
--    with real credentials when you want it back.
UPDATE email_accounts
SET status = 'inactive', updated_at = NOW()
WHERE email IN (
    'alex.send@acme.test', 'alex.outbound@acme.test',
    'beth.send@beta.test', 'beth.outbound@beta.test',
    'gus.send@gamma.test', 'gus.outbound@gamma.test',
    'alice@acme.test', 'bob@acme.test', 'hans@globex.test',
    'owner@warmbly.local'
);

-- Keep the owner's real Gmail mailbox untouched (smtp_imap entry pointing at
-- adityathakur452007@gmail.com in org 22222222-...-01); the reconcile loop
-- only republished it if it is actually assigned to a live worker.

-- Report what happened.
SELECT 'users' AS table_name, COUNT(*) AS rows_for_owner FROM users
    WHERE email = 'adityathakur452007@gmail.com'
UNION ALL
SELECT 'org_memberships', COUNT(*) FROM organization_members om
    JOIN users u ON u.id = om.user_id
    WHERE u.email = 'adityathakur452007@gmail.com'
UNION ALL
SELECT 'mailboxes_deactivated', COUNT(*) FROM email_accounts WHERE status = 'inactive';
