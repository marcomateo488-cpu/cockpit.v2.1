# Cockpit — Wagering Terminal

## What changed in this pass

### 1. Explicit "new round" step (no more silent auto-increment)
Previously, opening the BETTING phase silently incremented the round
counter as a side effect. Now:

- `POST /api/v1/admin/round/new` explicitly creates the next round.
  Only callable while the system is `CLOSED` and no round is already
  waiting to be opened.
- `POST /api/v1/admin/phase/BETTING` will now be **rejected** unless a
  round has been created and is waiting ("round ready").

This is implemented in `app/services/fight_state_service.py`
(`FightStateService.create_new_round()` / `.set_phase()`).

### 2. Enforced phase-transition pipeline
`FightStateService.ALLOWED_TRANSITIONS` defines the only legal moves:

```
CLOSED    -> BETTING
BETTING   -> COCKFIGHT
COCKFIGHT -> REDEEMING
REDEEMING -> CLOSED
```

Any other transition (e.g. starting a cockfight while still in
`REDEEMING`) is rejected with a 403 before anything changes. The admin
UI also disables any phase button that isn't the legal next step, so a
misinput is caught before the request is even sent.

### 3. "Overall close" — full system reset
`POST /api/v1/admin/system/reset` resets phase and round counter back
to a fresh idle system (`CLOSED`, round `#0`). Only allowed while
`CLOSED`, so it can't be used to wipe state out from under an in-flight
round. It never touches stored tickets or audit logs — only the live
in-memory phase/round machine. Use this once all rounds for the day are
finished, or to recover cleanly from a misinput/incident.

### 4. Renamed files/folders to match function

| Old                                   | New                                    | Why |
|----------------------------------------|-----------------------------------------|-----|
| `app/api/deps.py`                     | `app/api/auth_deps.py`                 | it's specifically auth/role dependencies |
| `app/api/v1/status.py`                | `app/api/v1/phase_status.py`           | clarifies it's read-only phase polling |
| `app/api/v1/admin.py`                 | `app/api/v1/fight_control.py` + `app/api/v1/reports.py` | split "things that change state" from "read-only admin views" |
| `app/api/v1/users.py`                 | `app/api/v1/accounts.py`               | matches "account management," not generic "users" |
| `app/api/v1/teller.py`                | `app/api/v1/tickets.py`                | function is ticket issuance/redemption, not "teller" the role |
| `app/services/phase_service.py`       | `app/services/fight_state_service.py`  | it's now a full round+phase state machine, not just phase |
| `frontend/teller.html` / `teller.js`  | `frontend/tickets.html` / `tickets.js` | matches the renamed ticket endpoints |

Endpoint prefixes were updated to match:
- `/api/v1/teller/*` → `/api/v1/tickets/*`
- `/api/v1/admin/users/*` → `/api/v1/admin/accounts/*`
- `/api/v1/status/phase` now also returns `round_ready`

## Project layout

```
cockpit/
├── requirements.txt
├── .env.example
└── app/
    ├── main.py
    ├── core/            (config, database, security)
    ├── models/          (user, bet, audit_log)
    ├── schemas/         (auth, ticket)
    ├── services/        (fight_state_service, barcode_service)
    └── api/
        ├── auth_deps.py
        └── v1/
            ├── auth.py
            ├── phase_status.py
            ├── fight_control.py   (round/new, phase/{name}, system/reset, fight-result)
            ├── reports.py         (monitor/tellers, tickets/{id}, reports/daily-income, audit-logs)
            ├── accounts.py
            └── tickets.py

frontend/
├── login.html
├── admin.html
├── tickets.html
├── css/style.css
└── js/
    ├── config.js
    ├── auth.js
    ├── admin.js
    └── tickets.js
```

## Running it

1. Copy `.env.example` to `.env` and fill in `DATABASE_URL` / `SECRET_KEY`
   / `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`.
2. `pip install -r requirements.txt`
3. `uvicorn app.main:app --reload` from the project root (the one
   containing `app/`).
4. Serve `frontend/` as static files (any static server), or open
   `login.html` directly if your browser allows local `fetch` to
   `127.0.0.1:8000`.

## Typical admin flow, end to end

1. **Round control → Start new round** (round #1 created).
2. **Phase controls → Open betting** (now allowed, since round is ready).
3. Tellers sell tickets.
4. **Phase controls → Start cockfight**.
5. **Declare fight result** (Meron/Wala/Draw) — this both resolves
   payouts and auto-advances to `REDEEMING`.
6. Tellers redeem winning tickets.
7. **Phase controls → Close system** (`REDEEMING` → `CLOSED`).
8. Repeat from step 1 for the next cockfight, or click **Overall close
   & reset system** once the whole event/day is done.
