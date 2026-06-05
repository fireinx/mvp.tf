# TF2 MVP Voting — Project Briefing

## Co robimy
Aplikacja do głosowania na MVP po meczu Team Fortress 2.
Użytkownik wkleja link z logs.tf → apka pobiera graczy → można głosować +1 (3 głosy per sesja).

## Domena
- `mvp.tf` kupiona na OVHcloud (27,99 zł/rok)
- Deploy: Vercel (darmowy plan)

## Aktualny stan UI (ZATWIERDZONY)
- Dark mode: tło #0f0f0f, tekst #e8e8e8
- Font: DM Mono
- Kolory drużyn: BLU #378ADD / RED #E24B4A
- Minimalistyczny: zero gradientów, płaskie przyciski, cienkie bordery
- Wynik meczu centralnie, lista graczy w dwóch kolumnach, ranking na dole
- 3 głosy per sesja (localStorage), max 1 głos na gracza

## Problem do rozwiązania
logs.tf API blokuje CORS — przeglądarka nie może bezpośrednio fetchować
`https://logs.tf/api/v1/log/{id}`.

Rozwiązanie: **Vercel Serverless Function** jako proxy.

## Architektura (do zbudowania)

```
przeglądarka
    ↓ fetch("/api/log?id=4066082")
Vercel Function (api/log.js)
    ↓ fetch("https://logs.tf/api/v1/log/4066082")  ← serwer nie ma CORS
logs.tf API
    ↑ zwraca JSON
Vercel Function
    ↑ zwraca JSON z nagłówkiem Access-Control-Allow-Origin: *
przeglądarka → renderuje graczy
```

## Struktura projektu do stworzenia

```
tf2-mvp/
├── api/
│   └── log.js          ← Vercel serverless function (proxy do logs.tf)
├── public/
│   └── index.html      ← cała apka (React z CDN, bez buildu)
├── package.json        ← minimalny, tylko dla Vercel
└── vercel.json         ← routing
```

## Głosowanie / storage
- Głosy są **per mecz** (key: logId)
- Limit per sesja w localStorage (nie współdzielony między użytkownikami)
- Na przyszłość: można podpiąć Vercel KV (darmowe 256MB) żeby głosy były shared

## Kroki wdrożenia
1. Zbudować strukturę plików (patrz niżej)
2. `git init && git push` do nowego repo GitHub
3. Vercel → Import project → deploy automatyczny
4. Vercel → Settings → Domains → dodać `mvp.tf`
5. OVHcloud → DNS → dodać rekordy od Vercel

## API logs.tf — format odpowiedzi
GET `https://logs.tf/api/v1/log/{id}`

Klucze których używamy:
- `info.map` — nazwa mapy
- `info.title` — tytuł meczu
- `info.date` — timestamp
- `teams.Blue.score` / `teams.Red.score` — wyniki
- `teams.Blue.players` / `teams.Red.players` — tablice SteamID
- `players.{steamId}.kills/deaths/dapm/class_stats` — statystyki
- `names.{steamId}` — nick gracza
- `success` — czy log istnieje

## UI — aktualny kod
Patrz plik: `index.html` (w tym samym folderze)
