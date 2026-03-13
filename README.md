# RentHome Online

Prosta aplikacja do zarzadzania najmem oparta o `Express`, sesje w `PostgreSQL` i frontend bez frameworka.

## Co jest teraz poprawione

- twardsza konfiguracja sesji i bezpieczniejsze logowanie
- sanitizacja danych przed zapisem i imporcie
- czyszczenie powiazan przy usuwaniu rekordow
- walidacja podstawowych formularzy i limit importu JSON
- porzadki repo: `.gitignore`, skrypty developerskie, kontrola skladni

## Wymagania

- Node.js 20+
- PostgreSQL
- zmienna `DATABASE_URL`

## Uruchomienie

```bash
npm install
npm run dev
```

Aplikacja domyslnie startuje na `http://localhost:3000`.

## Zmienne srodowiskowe

```bash
DATABASE_URL=postgres://user:password@localhost:5432/renthome
SESSION_SECRET=ustaw-dlugi-sekret-do-sesji
NODE_ENV=development
PORT=3000
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=mailer@example.com
SMTP_PASS=haslo-do-skrzynki
SMTP_FROM=RentHome <mailer@example.com>
SMTP_REPLY_TO=biuro@example.com
```

Mail wychodzacy z aplikacji wymaga poprawnej konfiguracji SMTP. Po ustawieniu tych zmiennych przyciski `Wyślij e-mail` w dokumentach, rozliczeniach i komunikacji wysyłają wiadomości bezpośrednio z backendu.

W produkcji `SESSION_SECRET` musi miec co najmniej 24 znaki.

## Kontrola projektu

```bash
npm run check
```

## Dalszy sensowny krok

Najwieksza kolejna poprawa to rozbicie `public/index.html` na osobne pliki `app.js` i `styles.css`, a potem przeniesienie glownego modelu danych z jednego `JSONB` do normalnych tabel domenowych.
