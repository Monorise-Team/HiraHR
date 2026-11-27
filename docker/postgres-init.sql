-- Baza hira_hr i jej role (ADR-0037, ADR-0096), tak jak w MonoriseCore i AvenMail:
-- - hira_hr_owner jest właścicielem tabel i uruchamia migracje,
-- - hira_hr_app to rola aplikacji: nie jest właścicielem tabel i nie ma BYPASSRLS, więc RLS obowiązuje ją zawsze.
-- Hasła tylko do pracy lokalnej i CI; na serwerze role i hasła zakłada infrastruktura.
CREATE ROLE hira_hr_owner LOGIN PASSWORD 'hira_hr_owner';
CREATE ROLE hira_hr_app LOGIN PASSWORD 'hira_hr_app';
CREATE DATABASE hira_hr OWNER hira_hr_owner;
-- Osobna baza testów lokalnych, żeby testy nie mieszały danych z pracą w przeglądarce
CREATE DATABASE hira_hr_test OWNER hira_hr_owner;
