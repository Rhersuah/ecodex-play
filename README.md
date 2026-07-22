# E-Codex Play — Backend + Web App

Isang totoong Node.js + Express + SQLite na backend, kasama ang lahat ng
HTML pages mo (Super Admin, Admin, User) na naka-connect na sa REAL na
database sa halip na localStorage.

---

## 1. Kasalukuyang Status (as of this build)

| Section | Status |
|---|---|
| Backend (auth, database, lahat ng API routes) | ✅ Kumpleto para sa 3 roles |
| Sign In / Sign Up page | ✅ Fully wired sa backend |
| **Super Admin** pages (dashboard, account, admin management, user management, fund management + deposit destinations, shop management, ticket/draw management, transaction approval, messages) | ✅ Fully wired sa backend |
| **Admin** pages (dashboard, account, user management, fund management + deposit destinations, shop management, ticket generator, transaction approval level-1, messages) | ✅ Fully wired sa backend |
| **User** pages (dashboard, account, balance/history, deposit funds, withdraw funds, buy tickets, my tickets, shop, messages) | ✅ Fully wired sa backend |
| `draw_management.html` (Admin) + `live_draw.html` / `drop_tickets.html` (User) | 🟡 Preview/demo lang — magandang visual na "weighted wheel spinner" pero hiwalay pa ito sa totoong ticket database. May paalala na banner sa mismong page. Ang **totoong** binibiling tickets ay nasa Ticket Generator (Admin) / Buy Tickets (User). |
| Deployment sa live internet | ⏳ Kailangan mo munang i-deploy (tingnan Part 4) |

**Isang app lang ito, isang beses mo lang ida-deploy.** Ang `backend/` folder na ito ay isang solong Node.js server na nagse-serve ng lahat ng 27 pages (Super Admin, Admin, User, Sign in/Sign up) at ng buong API — hindi mo kailangan mag-upload nang hiwa-hiwalay per role. Sinusunod din ang bawat parte ng "isahin ang validation": iisang set ng validation rules (bcrypt password hashing, role checks, balance checks, atbp.) ang ginagamit sa lahat ng roles dahil iisa lang silang backend.

---

## 2. Paano Patakbuhin sa Sarili Mong Computer (Local Test)

Kailangan mo muna ng [Node.js version 18 or higher](https://nodejs.org).

```bash
cd backend
npm install
cp .env.example .env
```

Buksan ang `.env` at palitan ang `JWT_SECRET` ng random na text. Pwede kang
gumawa ng isa sa pamamagitan ng:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

I-paste ang result sa `.env` bilang `JWT_SECRET=...`

Pagkatapos:

```bash
npm start
```

Makikita mo agad ito sa terminal:

```
============================================================
 ONE-TIME SUPER ADMIN LOGIN CREDENTIAL (E-Codex Play)
============================================================
 Username: root_xxxxxxxx
 Password: xxxxxxxxxxxxxxxxxxxx
============================================================
```

Buksan ang `http://localhost:4000` sa browser, mag-login gamit ang
credential na iyon (Sign In form), at agad kang hihilinging gumawa ng
**permanenteng** username at password. Kapag nagawa mo na iyon, mawawala
na ang temporary credential — hindi na ito muling lalabas kahit kailan,
tulad ng hiniling mo.

Kung na-lock out ka (nakalimutan ang bagong password bago ma-save), i-run
mo ito sa server terminal para makagawa ulit ng panibagong one-time
credential:

```bash
npm run reset-superadmin
```

---

## 3. Paano Gumagana ang Login/Roles (Buod)

- **Walang paraan para mag-sign-up bilang Admin o Super Admin.** Ang
  `/api/auth/signup` ay laging gumagawa ng `role: 'user'` lang.
- Ang mga Admin account ay ginagawa lamang ng isang naka-login na Super
  Admin, sa loob ng **Admin Management** page.
- Ang Super Admin ay walang normal na sign-up — isang beses lang
  gagana ang unang temporary credential, tapos permanente na ang
  account pagkatapos ng setup.
- Ang mga password ay naka-hash gamit ang bcrypt — hindi ito nakikita
  kahit ng may-ari ng server sa plain text.
- Deposit/Withdrawal ay dumadaan sa 2 antas: Admin (Level 1) → Super
  Admin (Level 2 / final release), kasama ang emergency bypass ng Super
  Admin kung na-stuck ang isang request sa Level 1.
- Ang totoong pangalan ng Admin/Super Admin ay hindi ipinapakita sa mga
  user sa Messages — makikita lang nila ang "E-Codex Play Support".

---

## 4. Pag-Deploy Online (Para Magamit ng Totoong Tao)

Dahil ito ay may sariling backend + database file, hindi ito pwedeng
i-drag-and-drop lang sa isang static hosting (hal. GitHub Pages). Kailangan
mo ng hosting na tumatakbo ng Node.js server nang tuloy-tuloy.

### Opsyon A — Render.com (pinakasimple para sa nagsisimula)
1. Gumawa ng GitHub repository at i-upload ang buong `backend/` folder.
2. Sa Render, gumawa ng bagong **Web Service**, ikonekta ang repo.
3. Build command: `npm install` — Start command: `npm start`
4. Sa **Environment** tab, ilagay ang `JWT_SECRET`, `NODE_ENV=production`, at **`DATA_DIR=/var/data`**.
5. **MAHALAGA:** ang SQLite database at mga na-upload na larawan ay
   kailangan mabuhay kahit mag-restart ang server. Render only allows
   **ONE persistent disk per service**, kaya isa lang ang gagawin mo:
   - Mount Path: `/var/data`
   - Size: 1 GB ay sapat na sa simula (pwede itaas paglaon)

   Dahil na-set mo ang `DATA_DIR=/var/data`, awtomatikong gagamitin ng app
   ang parehong disk na iyon para sa database AT sa lahat ng
   na-a-upload na larawan (proof of payment, avatars, atbp).

### Opsyon B — Railway.app
Halos parehas ang proseso; may built-in na "Volumes" feature si Railway
na madaling i-attach sa `data/` at `uploads/` folder para hindi mabura ang
datos.

### Opsyon C — Sariling VPS (DigitalOcean, Vultr, atbp.)
Ito ang pinaka-flexible at kadalasang pinipili kapag totoong pera na ang
dadaan. Gamitin ang `pm2` para patuloy na tumakbo ang server, at
`nginx` bilang reverse proxy papunta sa `localhost:4000` na may sariling
domain at **HTTPS/SSL** (kailangan ito para sa secure cookies pag
`NODE_ENV=production`).

### Bagay na dapat tandaan sa ANUMANG hosting:
- Kailangan ng **HTTPS** (hindi lang plain HTTP) bago mo i-set ang
  `NODE_ENV=production`, dahil doon nagiging `secure` ang login cookie.
- I-back up nang regular ang `data/ecodex.sqlite` file — ito ang buong
  database mo (users, balances, transactions, lahat).
- Ang mga larawan sa `uploads/` (proof of payment, avatars, atbp.) ay
  kailangan din ma-back up.

---

## 5. Tungkol sa Real-Money Deposits/Withdrawals

Ang app na ito ay hindi direktang kumokonekta sa GCash/Maya/bank
(walang totoong payment gateway na naka-integrate). Ang ginagamit na
proseso ay:

1. Nilalagay ng Super Admin/Admin ang mga deposit destination (GCash
   number, bank account, atbp.) sa **Funds Management**.
2. Nag-de-deposito ang user gamit ang detalyeng iyon sa labas ng app
   (sa aktwal na GCash/bank app nila), tapos nag-a-upload ng proof of
   payment sa loob ng E-Codex Play.
3. Nire-review ito ng Admin, tapos pinal na ini-a-approve ng Super Admin
   bago madagdag sa balance ng user.

Tandaan: pagpapatakbo ng real-money raffle/lottery platform ay
kadalasang nangangailangan ng espesyal na permit/lisensya depende sa
bansa (hal. sa Pilipinas, maaaring kasama ang PAGCOR o local government
regulations). Iminumungkahi naming kumonsulta ka sa isang abogado o sa
tamang ahensya bago mo tuluyang ilunsad ito publicly.

---

## 6. Tungkol sa "Weighted Wheel" na Draw Tool

May tatlong pages (`admin/draw_management.html`, `user/live_draw.html`, `user/drop_tickets.html`) na naiwan bilang isang magandang-tingnan na **visual demo** ng isang chance-weighted na spinning wheel raffle. Hindi pa ito kumokonekta sa parehong database ng totoong ticket system (yung Buy Tickets / Ticket Generator / Transaction Approval). Kung gusto mong gawin itong totoong paraan ng pag-draw (halimbawa: mas kumplikadong sistema kung saan iba't-ibang laki ng "chance %" ang bawat ticket sa halip na simpleng random number matching), sabihin mo lang at gagawan ko ng sariling backend logic ito.

## 7. System Status (Maintenance / Updating / Shutdown Screens)

Bago mo lubusang ilunsad ang site, may bagong feature na: pwede mong
kontrolin ang buong site status mula sa Super Admin panel:

- Pumunta sa **Super Admin → Settings** (`system-control.html`)
- Piliin: **Online**, **Maintenance**, **Updating**, o **Shutdown**
- Pwede kang maglagay ng custom na mensahe (hal. "Babalik kami by 9PM")
- Kapag hindi "Online" ang status, lahat ng Admin at User ay makikita
  na lang ang animated na status screen (`status.html`) — hindi sila
  makaka-access ng kahit anong parte ng app
- **Ikaw lang bilang Super Admin ang laging may access**, kahit anong
  status ang nakatakda — para makapag-ayos ka pa rin at mabalik sa Online
  kapag tapos na

Ito ay totoong ipinapatupad sa backend (hindi lang itinatago sa frontend),
kaya hindi ito pwedeng i-bypass sa pag-tawag mismo sa API.

## 8. Google / Facebook Login Setup

Gumagana na ang mga button na "Continue with Google/Facebook" — pero
**hindi ako makakagawa ng totoong credentials para sa'yo**, dahil ang mga
ito ay nakatali sa sarili mong pagkakakilanlan bilang developer/negosyo.
Kailangan mong kumuha ng sarili mong Client ID/Secret:

### Google
1. Pumunta sa [Google Cloud Console](https://console.cloud.google.com/) → gumawa ng bagong project
2. **APIs & Services → Credentials → Create Credentials → OAuth Client ID**
3. Application type: **Web application**
4. Sa "Authorized redirect URIs," ilagay ang eksaktong URL ng server mo + `/api/auth/google/callback`
   (hal. `https://e-codex-play.onrender.com/api/auth/google/callback`)
5. Kopyahin ang **Client ID** at **Client Secret**, ilagay sa `.env`:
   ```
   GOOGLE_CLIENT_ID=xxxxx
   GOOGLE_CLIENT_SECRET=xxxxx
   GOOGLE_REDIRECT_URI=https://your-domain.com/api/auth/google/callback
   ```

### Facebook
1. Pumunta sa [developers.facebook.com](https://developers.facebook.com/) → **My Apps → Create App**
2. Idagdag ang **Facebook Login** product
3. Sa Settings, ilagay ang redirect URL: `https://your-domain.com/api/auth/facebook/callback`
4. Kopyahin ang **App ID** at **App Secret** mula sa Settings → Basic:
   ```
   FACEBOOK_CLIENT_ID=xxxxx
   FACEBOOK_CLIENT_SECRET=xxxxx
   FACEBOOK_REDIRECT_URI=https://your-domain.com/api/auth/facebook/callback
   ```
5. **Paalala:** habang naka-"Development Mode" ang Facebook app mo, tanging
   mga taong idinagdag mo bilang "Testers" sa Facebook Developer dashboard
   ang makakapag-login gamit ito. Kailangan mo ng **App Review** ni Facebook
   bago ito magamit ng publiko — proseso ito na maaaring tumagal ng ilang araw.

**Kung hindi mo pa ito ma-set up ngayon:** okay lang — automatic na
ipapakita ng app ang isang magalang na mensahe ("Hindi pa naka-configure...")
sa halip na mag-crash, at gagana pa rin ang normal na Sign In/Sign Up gamit
ang email/password.

## 9. Bawat Tab, Hiwalay na Login Session

Kung minsan gusto mong buksan ang Super Admin sa isang browser tab, at
Admin naman sa ibang tab, sa **parehong laptop/computer** — gumagana na
ito ngayon nang tama. Bawat tab ay may sariling hiwalay na login session
(gamit ang `sessionStorage` sa halip na cookies), kaya hindi na
nagpapalitan ang mga account kapag lumipat-lipat ka ng tabs.

**Paalala:** kapag isinara mo ang isang tab, mawawala ang session doon —
kailangan mong mag-login ulit kapag bumukas ka ng bagong tab. Normal lang
ito, para sa seguridad.

## 10. Email Verification Setup (Bagong User Signups)

Ngayon, kapag nag-signup ang isang user, hindi sila diretsong makaka-login.
Dalawang hakbang muna:
1. **I-verify ang email** — may 6-digit code na ipapadala sa email nila
2. **I-approve ng Admin o Super Admin** — makikita ito sa "Account Approvals"
   sa sidebar

**Mahalaga:** kung wala kang na-set up na SMTP (email sending), gagana pa
rin ang buong flow, pero sa halip na totoong email, ipapakita na lang
DIREKTA ang code sa screen mismo ("dev mode") — para makapag-test ka
agad kahit wala pang email setup. Pero **kailangan mo talaga i-configure
ang totoong email bago mo ilabas ang site sa totoong users**, dahil hindi
nila makikita ang code kung hindi ito totoong ipinadala sa email nila.

### Paano mag-set up ng totoong email (gamit ang Gmail)
1. I-on ang **2-Step Verification** sa Google Account mo
   (myaccount.google.com/security)
2. Pumunta sa **myaccount.google.com/apppasswords**
3. Gumawa ng App Password para sa "Mail" — kokopyahin kang 16-character code
4. Ilagay sa `.env` file mo:
   ```
   EMAIL_SMTP_HOST=smtp.gmail.com
   EMAIL_SMTP_PORT=587
   EMAIL_SMTP_SECURE=false
   EMAIL_SMTP_USER=your-email@gmail.com
   EMAIL_SMTP_PASS=xxxx xxxx xxxx xxxx
   EMAIL_FROM=E-Codex Play <your-email@gmail.com>
   ```
5. I-restart ang server (`npm start`)

Puwede ring gamitin ang ibang email provider (Zoho, Outlook, o kahit
transactional email service tulad ng SendGrid) — palitan mo lang ang
`EMAIL_SMTP_HOST`/`EMAIL_SMTP_PORT` ayon sa provider na iyon.

## 11. MAHALAGA: Backup Bago Mag-Update (Huwag Basta-Basta Mag-Delete!)

**Lahat ng datos mo — users, tickets, balances, transactions, larawan, at ang security key mo — ay nasa loob ng `backend\data\ecodex.sqlite` at `backend\.env`.** Kapag binura mo ang buong `backend` folder para palitan ng bagong bersyon (updated code na binigay ko), **mawawala ito nang tuluyan** kung hindi ka muna nag-backup.

### Bago mag-delete ng backend folder:

```powershell
cd E:\E-codex-Play\backend
npm run backup
```

Ito ay awtomatikong gagawa ng bagong folder na `E:\E-codex-Play\ecodex-backups\` (**sa LABAS** ng backend folder, kaya ligtas ito kahit anong gawin mo sa loob) — doon naka-save ang kopya ng iyong database, ang `.env` mo (para hindi na kailangang gumawa ulit ng bagong security key), at mga na-upload na larawan.

**I-verify muna:** tingnan ang laki ng `ecodex.sqlite` sa loob ng bagong backup folder — kung alam mong marami ka nang users/tickets pero maliit lang ang file (halos 0 KB), may problema — huwag munang magpatuloy.

### Pagkatapos mag-extract ng bagong zip — SUNDIN NANG SUNOD-SUNOD:

**Mahalagang paalala:** kailangang i-restore muna ang database **BAGO** ang unang `npm start` — kung hindi, awtomatikong gagawa ang system ng bagong Super Admin account (dahil akala niya bagong-bago pa lang ang system), at hindi na makikilala ang luma mong credentials.

1. I-extract ang bagong zip, tapos:
   ```powershell
   cd E:\E-codex-Play\backend
   npm install
   ```
   **Huwag pang patakbuhin ang `npm start`.**

2. Gumawa ng `data` folder:
   ```powershell
   mkdir data
   ```

3. Buksan ang File Explorer, pumunta sa backup folder mo (may petsa/oras ang pangalan, hal. `2026-07-11T02-30-30`)

4. I-copy ang `ecodex.sqlite` mula sa backup folder → i-paste sa loob ng bagong `backend\data\` folder

5. I-copy rin ang `.env` mula sa backup folder → i-paste sa **loob mismo ng bagong `backend` folder** (kasabay ng `server.js`, hindi sa loob ng `data`) — kapalit ito ng kahit anong `.env` na baka nagawa mo na mula sa `.env.example`

6. Kung meron kang `uploads` folder sa backup, i-copy rin ito papunta sa **loob mismo ng bagong `backend` folder**

7. **Ngayon lang** patakbuhin:
   ```powershell
   npm start
   ```

Dahil kompleto na ang lahat bago pa man unang tumakbo ang server, babalik agad ang lahat ng users, tickets, balances — **at ang luma mong Super Admin credentials ay gagana pa rin, walang bagong random na account na gagawin.** Kung tama ang ginawa mo, **hindi** dapat lumabas ang "ONE-TIME SUPER ADMIN LOGIN CREDENTIAL" na mensahe sa console.

**Payo:** gawin mong ugali ang `npm run backup` bago ka gumawa ng anumang malaking pagbabago sa system, hindi lang pag mag-a-update — ligtas na palagi.

## 12. Kung May Karagdagan Ka Pa

Ang buong system ay isang backend (`/backend`), kaya kahit anong susunod mong hilingin — bagong feature, bagong validation, ayusin ang isang partikular na page — babaguhin lang natin ang mga file dito at pareho pa ring iisang `npm start` at isang deployment ang kailangan.
