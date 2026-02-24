# Bedroc — Security & Privacy Q&A

This document answers honest, detailed questions about the security and privacy model of Bedroc as designed in `INITIAL-PLAN.md`. It covers what the system protects against, where the genuine limits are, and what users need to understand about their own responsibilities.

---

## Is the security top-tier?

**Mostly yes, with honest caveats.**

The design uses the same primitives trusted by Signal, ProtonMail, and iCloud Advanced Data Protection:

- **AES-256-GCM** — the gold standard for symmetric authenticated encryption. No practical attack exists against it today.
- **PBKDF2 (600,000 iterations, SHA-256)** — meets the current NIST recommendation. Makes brute-forcing passwords extremely expensive even with a GPU farm.
- **SRP (Secure Remote Password)** — the password never travels over the network, even in hashed form. A man-in-the-middle or a compromised server cannot extract a password from the login traffic.
- **Two-layer key architecture** (Master Key → DEK → notes) — industry-standard design used by 1Password and similar.
- **WebCrypto API** — browser-native, audited, constant-time implementations. No third-party crypto library needed.

What holds it back from "absolute top tier" right now:

- **PBKDF2 vs Argon2id**: Argon2id is memory-hard and more resistant to GPU/ASIC attacks than PBKDF2. The plan acknowledges this and offers Argon2-WASM as an upgrade. This is a real gap that should be closed before a large public release.
- **Post-quantum encryption**: The plan notes CRYSTALS-KYBER (ML-KEM) as a future upgrade. At the time of writing, WebCrypto does not natively support post-quantum algorithms. X25519 and AES-256-GCM are safe today but not quantum-resistant. This only becomes a concern if a sufficiently powerful quantum computer is built — none exist today capable of breaking these.
- **JavaScript runtime**: No cryptographic operation in a browser-based JS app has the same memory isolation guarantees as a native compiled app. A sophisticated attacker with local code execution on your device can potentially extract keys from JS memory. This is a fundamental limit of the browser/PWA model, not a design flaw.

---

## If the server gets hacked, what can the attacker get?

**Very little of meaningful value.**

Here is exactly what the attacker obtains from a full database dump:

| Data | What attacker gets | Can they read your notes? |
|---|---|---|
| Note content (`encrypted_content`) | AES-256-GCM ciphertext blobs | No — useless without the DEK |
| Note title (`encrypted_title`) | AES-256-GCM ciphertext | No |
| DEK (`encrypted_dek`) | AES-256-GCM ciphertext of the DEK | No — useless without the Master Key |
| DEK salt (`dek_salt`) | Random bytes | Only useful to help derive your Master Key if they also know your password |
| SRP verifier (`srp_verifier`, `srp_salt`) | A mathematical verifier, not a password hash | Cannot be reversed to get your password; cannot be used to derive your Master Key directly |
| Username | Plaintext | Yes — usernames are not encrypted |
| Note count / timestamps | Plaintext metadata | Yes — they know you have N notes and roughly when you edited them, but not what they say |
| Session tokens | Hashed — useless after logout | No — raw tokens are never stored |

**The attacker cannot read a single word of your notes.** To decrypt them, they would need your password, which is never sent to or stored on the server in any recoverable form.

The server is intentionally designed to be a dumb encrypted storage bucket. Even a fully cooperative, malicious server operator cannot read your notes.

### What if the attacker also modifies data on the server?

A hacker with write access could:
- **Delete your notes** (catastrophic for data, but cannot read them)
- **Replace encrypted blobs with garbage** (your client would fail to decrypt and show an error)
- **Corrupt your encrypted DEK** (you would be locked out until you restore from backup)
- **Replay old encrypted versions** of notes (serve you a stale note; your client would decrypt it fine, but the content would be outdated)

None of these allow reading your data. They are integrity attacks, not confidentiality attacks. Future mitigation: signing note blobs with a client-side key, so the client can detect server-side tampering.

---

## If the client device gets hacked, but the user was logged out?

**You are safe, with conditions.**

On logout, the plan mandates:
1. The DEK is zeroed from JavaScript memory
2. IndexedDB session/key data is cleared
3. Service worker caches are cleared

If these steps execute correctly, an attacker who gains access to your device after logout has nothing useful:
- The DEK is gone from memory
- No keys remain in IndexedDB
- No decrypted note content is cached

**Conditions and limits:**

- **"Logged out" must mean the browser was closed or the tab was closed**, not just that you navigated away. JavaScript memory is process-scoped; the DEK lives only in the tab's memory. When the tab is closed, the OS reclaims that memory.
- **Swap / hibernation files**: Modern OSes can page JS heap memory to disk. In theory, forensic tools could recover key material from a swap file or a hibernation image after the fact. This is a hardware/OS-level concern and applies to essentially all software, including Signal Desktop.
- **Browser crash before logout**: If the browser crashes while you are logged in, the in-memory DEK may not be zeroed. The OS will eventually overwrite that memory, but it is not guaranteed to be immediate. The "remember me" persistent login case stores a wrapped key in IndexedDB — this persists until the user explicitly logs out.
- **Malware already running while logged in**: If the attacker has code execution on your device *while you are actively logged in*, they can read the DEK from JS memory or intercept note content before encryption. Logout does not retroactively undo this. This is the hardest threat to defend against at the application layer.

---

## If the client device gets hacked while logged in?

**This is the realistic worst case.** If an attacker has arbitrary code execution on your device while you have an active Bedroc session:

- They can read the DEK from JavaScript memory
- They can intercept note content after decryption
- They can read your keystrokes (new notes as you type them)
- They can exfiltrate your notes through the malware's network channel

**Bedroc cannot protect against a fully compromised client.** No E2EE application can. Signal, ProtonMail, and Bitwarden have the same fundamental limit. Device security is the user's responsibility. Keep your device patched, use full-disk encryption, and do not install untrusted software.

---

## Is it completely safe?

**No application is completely safe. Here is an honest breakdown:**

| Threat | Protection | Level |
|---|---|---|
| Server database breach | E2EE — attacker gets encrypted blobs only | Strong |
| Network interception (MITM) | TLS + SRP — no plaintext or password on wire | Strong |
| Malicious server operator | Cannot decrypt your data | Strong |
| Brute-force password attack (offline, after DB breach) | PBKDF2 600k iterations makes it very slow | Good (Argon2id would be better) |
| Quantum computing (future) | Current ciphers are vulnerable eventually | Planned mitigation (ML-KEM) |
| Logged-out device access | Keys cleared on logout | Good (with caveats above) |
| Logged-in device with malware | No protection at application layer | None possible |
| Phishing (fake login page) | User education; open-source so UI is verifiable | User responsibility |
| Weak password chosen by user | Client-side password strength enforcement | Partial |
| Physical device seizure while logged in | No protection | None possible |
| Browser/OS memory forensics post-logout | Memory overwrite not guaranteed | Partial |
| Data loss (server deleted/destroyed) | IndexedDB offline copy + export feature | Good |

---

## Can any entity other than the user read their notes?

**No, by design — with the caveats already noted.**

To decrypt a user's notes, an entity would need:

1. The encrypted DEK (stored on server — obtainable by hacking the DB)
2. The DEK salt (stored on server — obtainable by hacking the DB)
3. The user's password (never stored anywhere, only in the user's head)

Items 1 and 2 are publicly available to an attacker who compromises the server. Item 3 is not. Without the password, the Master Key cannot be derived, and the DEK cannot be decrypted.

The only ways another entity can read your notes are:

- They know your password (you told them, they guessed it, or they captured it via malware/phishing)
- They have malware running on your device while you are logged in
- A catastrophic, currently-unknown break in AES-256-GCM or PBKDF2 is discovered (considered infeasible for the foreseeable future)
- A government with a quantum computer (post-quantum mitigation is planned)

**The server operator specifically cannot read your notes**, even if they want to. This distinguishes Bedroc from standard cloud notes apps (Google Keep, Notion, Evernote) where the provider has full access to your plaintext data.

---

## External dependencies and APIs?

**None by design.** This is an explicit requirement from the project spec.

- All npm dependencies are installed locally and vendored — no CDN calls at runtime
- No third-party analytics, telemetry, or tracking
- No external auth providers (no "Sign in with Google")
- No external storage (no S3, no Firebase, no Cloudflare)
- No external fonts or icon libraries fetched from CDNs at runtime — all self-hosted
- Crypto is done via the browser's built-in WebCrypto API — no external crypto library

**The only network calls the app makes:**
1. To your own Bedroc server (for sync, auth, note storage)
2. Nothing else

A user who self-hosts Bedroc on a machine with no internet access (e.g., a local LAN or Tailscale mesh) can use it entirely offline once the app is loaded and installed as a PWA.

---

## What does the server/database know and store?

**Exactly this — no more:**

### About you (users table)
- Your **username** (plaintext — this is necessarily known for login lookup)
- Your **SRP verifier and salt** — a one-way mathematical value derived from your password. It proves you know the password without revealing it. Cannot be reversed to obtain your password.
- Your **encrypted DEK and DEK salt** — the DEK is AES-256-GCM encrypted. Without your password, it is useless ciphertext.
- Account creation and update timestamps

### About your notes (notes table)
- A **UUID** for each note — random, reveals nothing
- Your **user ID** — links notes to your account
- The **encrypted content** of each note — AES-256-GCM ciphertext. Completely opaque to the server.
- The **encrypted title** of each note — same, completely opaque
- **Timestamps**: when you created a note, when you last updated it, when it was synced. These are not encrypted. The server knows *when* you write notes, but not *what* they contain.
- **Soft-delete flag** and **version number** — for sync purposes
- **Note count** — the server knows how many notes you have

### About your sessions (sessions table)
- A **hash** of your JWT token (for revocation — the raw token is never stored)
- Which **device** logged in (user-agent string, if sent)
- Session creation, expiry, and revocation timestamps

### What the server explicitly does NOT know:
- Your password, in any form
- The plaintext content of any note, ever
- The plaintext title of any note, ever
- Your Data Encryption Key (DEK), in plaintext
- Any derived cryptographic keys

### What the server logs (if logging is implemented correctly)
- Request metadata: IP address, HTTP method, path, status code, timestamp
- **Not** request bodies (which contain encrypted blobs — logging them would be wasteful and leak ciphertext volume)
- IP addresses are a privacy consideration: a conscientious self-hoster may want to disable or anonymize IP logging

---

## What does the client store?

### In memory (RAM, cleared when tab closes or on logout)
- The **Data Encryption Key (DEK)** — the most sensitive item; cleared on logout
- Decrypted note content currently being viewed or edited

### In IndexedDB (persists across sessions, cleared on logout or browser data clear)
- **Encrypted copies of all notes** — same ciphertext as the server, safe to store
- **Offline write queue** — encrypted note blobs waiting to sync
- **For "remember me"**: a device-specific wrapped key that allows DEK recovery without re-entering password. This is protected by a device-tied random secret also in IndexedDB. If an attacker has full read access to IndexedDB (e.g., via malware), they could potentially extract this. This is a usability vs. security trade-off.

### In service worker cache
- **App shell** (HTML, CSS, JS) — the application code itself, no user data
- Cached responses may include encrypted note blobs from recent API calls

### What the client does NOT persist
- Your plaintext password (never written to storage anywhere)
- The DEK in plaintext outside of memory
- Decrypted note content (notes are always stored encrypted, decrypted on demand in memory)

---

## What about the "remember me" / persistent login trade-off?

This is worth understanding clearly because it is a meaningful security trade-off.

**Without "remember me"** (most secure): The DEK exists only in RAM. Close the tab or log out and it is gone. You must type your password on every new session. This means no trace of the DEK is ever written to disk.

**With "remember me"** (more convenient, slightly weaker): The DEK is wrapped with a device-specific key and stored in IndexedDB. This survives browser restarts. An attacker with local access to your browser profile (e.g., physical access, malware) could potentially extract this wrapped key. The device-specific wrapping adds a layer, but it is not equivalent to "nothing on disk."

Recommendation for high-security environments: disable "remember me", accept the need to re-enter your password each session.

---

## Are all network requests encrypted? Is TLS alone enough against MITM?

**TLS alone is not sufficient. Bedroc has multiple additional layers.**

You are right that HTTPS/TLS can be bypassed. Real MITM attack vectors include:

- A rogue or compromised Certificate Authority (CA) issuing a fake certificate for your domain
- SSL stripping attacks (downgrading HTTPS to HTTP if HSTS is not enforced)
- An attacker on your local network with a self-signed cert and ARP spoofing
- Corporate/government proxies that perform TLS inspection by installing a trusted root CA on managed devices

Here is how Bedroc defends against each layer:

### Layer 1 — TLS (transport)

All traffic travels over TLS 1.3 (enforced by Nginx config — TLS 1.0/1.1/1.2 disabled). This encrypts everything on the wire against passive eavesdropping. Necessary but not sufficient on its own.

### Layer 2 — HSTS (HTTP Strict Transport Security)

The server sends `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`. This tells browsers:

- Never connect to this domain over plain HTTP, ever
- Refuse any connection attempt that isn't TLS — even if a MITM redirects to HTTP
- `preload` means the domain can be submitted to browser preload lists so this protection applies even on first visit before the header is seen

This defeats SSL stripping. The browser will hard-refuse the downgraded connection.

### Layer 3 — SRP (Secure Remote Password protocol)

This is the most important layer for MITM. Even if an attacker successfully breaks TLS — via a rogue CA, a corporate proxy, or any other method — they still cannot obtain your password. Here is why:

SRP is a **zero-knowledge proof** protocol. The client and server run a mathematical exchange where:

- The client proves it knows the password without transmitting it or any equivalent
- The server proves it has your stored verifier without transmitting it
- Both sides derive a shared session key; an eavesdropper who sees all traffic cannot compute this key

An active MITM who terminates TLS and relays traffic would see the SRP exchange but cannot extract the password or impersonate the server without detection — the SRP handshake would fail because they do not have the stored verifier.

### Layer 4 — Application-layer E2EE (the deepest layer)

Even in the hypothetical scenario where TLS is broken AND SRP is somehow bypassed, the attacker still only receives:

- The encrypted DEK (AES-256-GCM ciphertext — useless without Master Key)
- Encrypted note blobs (AES-256-GCM ciphertext — useless without DEK)

The application-layer encryption is entirely independent of TLS. A MITM who can read all traffic gets nothing but ciphertext. This is the critical design principle: **the network is treated as untrusted. Security does not depend on TLS being unbroken.**

### Layer 5 — Certificate Transparency + HPKP (optional, advanced)

Modern browsers enforce Certificate Transparency (CT) — every publicly trusted certificate must be logged in public CT logs. A rogue CA issuing a fake cert for your domain would be detectable via CT monitoring tools.

HTTP Public Key Pinning (HPKP) can further tell browsers to only accept specific certificate public keys for a domain, blocking rogue CA attacks entirely. HPKP is aggressive and can break your site if misused, so it is optional and primarily relevant for high-security deployments.

### Summary table

| Attack | Defeated by |
| --- | --- |
| Passive eavesdropping | TLS |
| SSL stripping / HTTP downgrade | HSTS + preload |
| Rogue CA / certificate spoofing | CT monitoring; optional HPKP; SRP (password still not exposed); E2EE (data still encrypted) |
| TLS interception proxy (corporate) | SRP (password never on wire); E2EE (data still encrypted) |
| Full TLS break (theoretical) | SRP + E2EE — attacker still gets only ciphertext |
| Compromised server relaying traffic | SRP + E2EE — server never had plaintext to give |

---

## Offline brute force after a DB breach — how protected are we really?

**This is a valid concern and one of the most important honest answers in this document.**

You are correct that users typically choose weak passwords. Here is the realistic picture.

### What the attacker actually has after stealing the database

They have:

- `srp_verifier` — used to verify login attempts
- `srp_salt` — used in SRP verification
- `encrypted_dek` — AES-256-GCM ciphertext of the DEK
- `dek_salt` — the salt used to derive the Master Key from the password

Both `srp_verifier` and `encrypted_dek` can be independently used as oracles for offline password guessing.

### Attack path 1 — Brute-forcing via the SRP verifier

The SRP verifier is `v = g^x mod N` where `x = H(srp_salt || H(username ":" password))`. An attacker can compute trial values of `x` for candidate passwords and check if `g^x mod N` matches the stolen verifier. This is structurally similar to cracking a traditional password hash.

**With PBKDF2-SHA256 at 600,000 iterations:**

- A single high-end GPU (RTX 4090) can compute roughly **700–1,500 PBKDF2-SHA256 guesses per second** at 600k iterations
- A wordlist attack against "password123" would succeed in seconds
- A full lowercase+digit 10-character brute force: ~3.7 × 10¹⁵ combinations ÷ 1,000/s ≈ **117 million years** per GPU
- A targeted dictionary/rule attack against a typical user password (common word + numbers + symbols): **hours to days**

**With Argon2id (the planned upgrade):**

Argon2id is memory-hard — it requires large amounts of RAM per guess, which cannot be parallelized on a GPU the way PBKDF2 can. A properly tuned Argon2id configuration (e.g., 64 MB memory, 3 iterations) reduces GPU throughput to roughly **5–20 guesses per second**, regardless of GPU count. This makes even targeted dictionary attacks on typical passwords infeasible:

- "Password1!" at 10 guesses/sec on 100 GPUs: still ~3 days for a smart targeted attack
- But most passwords are not "Password1!", and a realistic crack rate drops dramatically

**This is why the plan must prioritize upgrading PBKDF2 → Argon2id before public release.**

### Attack path 2 — Brute-forcing via the encrypted DEK

The attacker runs: `PBKDF2(candidate_password, dek_salt)` → trial Master Key → attempt to AES-256-GCM decrypt the `encrypted_dek`. If the GCM authentication tag verifies, the password is correct.

This has the same cost as attack path 1 (bounded by the KDF speed) and additionally confirms the correct password definitively. With AES-GCM, a wrong password produces an authentication failure immediately — there is no ambiguity. This is not a weakness; it just means each guess is a clean yes/no.

### What other protections exist beyond KDF slowness?

**The SRP verifier is not a simple password hash.** The discrete logarithm problem underlying SRP makes it computationally harder than a straight bcrypt/PBKDF2 comparison for an attacker building a rainbow table or precomputed table, because the verifier is salt-dependent and group-element-based. However, online and targeted offline attacks are still feasible with weak passwords. Do not treat this as a strong defense on its own.

**The two-layer key architecture limits blast radius.** An attacker who cracks one weak password gets access to only that user's notes. They cannot use it to derive keys for any other user — each user has an independent random DEK and independent salts.

**AES-256-GCM for note content is computationally unbreakable.** The weak point is the password-to-Master Key derivation (PBKDF2/Argon2id), not the note encryption itself. Once an attacker has the correct DEK, decrypting notes is instant.

### The honest bottom line on weak passwords

If a user chooses "iloveyou2024" as their password and the database is breached:
- **With PBKDF2 600k**: A resourceful attacker with a wordlist and a few GPUs will likely crack it within hours to a few days.
- **With Argon2id (64 MB, 3 iter)**: That same attack takes weeks to months on the same hardware, and is significantly more expensive.

Neither protects against "password123". The correct mitigations are:

1. **Upgrade to Argon2id** — the single most impactful change (planned)
2. **Enforce strong passwords client-side** — minimum entropy checker, not just length (e.g., use zxcvbn)
3. **Educate users** — the security model is only as strong as the password. Make this explicit in the UI.
4. **Consider a passphrase generator** — offer users a randomly generated passphrase (e.g., 5 random words = ~65 bits of entropy) as the default registration suggestion. This is far stronger than typical user-chosen passwords and easier to remember than random characters.

Realistically, Bedroc with Argon2id + a strong-password enforcer is substantially better than any traditional notes app, and is comparable to what password managers provide for vault encryption. It is not unconditionally unbreakable, which no system is. The combination of Argon2id + E2EE + SRP puts the realistic attack cost for a motivated, well-resourced attacker in the range of months to years for a decently chosen password — which is the industry standard for this class of application.

---

## Updated security threat table (revised)

| Threat | Protection | Honest Level |
|---|---|---|
| Server database breach (read only) | E2EE — attacker gets encrypted blobs only; cannot read notes | Strong |
| Offline brute force after DB breach (weak password) | PBKDF2 600k (current) — breakable with wordlist in hours/days | Weak — **must upgrade to Argon2id** |
| Offline brute force after DB breach (strong password) | PBKDF2 600k — infeasible for random/high-entropy passwords | Good |
| Offline brute force after DB breach (Argon2id, any password) | Memory-hard, GPU-resistant — wordlist attacks become weeks/months | Strong |
| Network interception, passive eavesdropping | TLS 1.3 | Strong |
| SSL stripping / HTTP downgrade | HSTS + preload | Strong |
| MITM via rogue CA or TLS break | SRP (password not on wire) + E2EE (data encrypted at app layer) | Strong |
| Malicious / compromised server operator | E2EE — server never has plaintext keys or content | Strong |
| Logged-out device access | Keys cleared on logout; nothing persists in plaintext | Good (with OS-swap caveats) |
| Logged-in device with malware | No application-layer protection possible | None possible |
| Phishing / fake login page | SRP prevents password capture; open-source UI is verifiable | Partial — user education required |
| Weak password chosen by user | Argon2id slows brute force; zxcvbn enforces minimum entropy | Partial — user is ultimately responsible |
| Quantum computing (future) | AES-256 and X25519 are vulnerable eventually; ML-KEM planned | Planned |
| Data loss / server destroyed | IndexedDB offline copy + JSON export | Good |
| Server-side data tampering | Client detects decryption failure; note signing planned (Phase 8) | Partial |

---

## Do two users with the same password get the same keys or hashes? Can they access each other's data?

No. This is prevented by salting, and it is worth understanding clearly.

At registration, the server generates two independent random values for each user: `srp_salt` and `dek_salt`. These are unique per account, created fresh with a cryptographically secure random number generator. They are stored in the database alongside that user's record.

Because of these salts, even two users who choose the exact same password end up with completely unrelated cryptographic material:

```
User A: PBKDF2("hunter2", srp_salt_A) → SRP verifier A   (different)
        PBKDF2("hunter2", dek_salt_A) → Master Key A      (different)
        Master Key A wraps DEK A                           (different, random)

User B: PBKDF2("hunter2", srp_salt_B) → SRP verifier B   (different)
        PBKDF2("hunter2", dek_salt_B) → Master Key B      (different)
        Master Key B wraps DEK B                           (different, random)
```

User A's SRP verifier cannot be used to log in as User B. User A's Master Key cannot unwrap User B's DEK. Their note ciphertext is encrypted under entirely different DEKs. Knowing one user's password gives zero information about any other user's data.

The same applies to a user who deletes their account and re-registers with the same username and password. New salts are generated at registration, so new keys are derived. The old encrypted data, if deleted server-side, is permanently irretrievable — even by the user themselves, since the old DEK no longer exists anywhere.

There is also no concept of "same email" as a vulnerability surface here because Bedroc uses usernames, not email addresses, and uniqueness is enforced at the database level (`UNIQUE` constraint on the `username` column). Two accounts with the same username cannot exist.

---

## Where are the salts and DEK stored, and how does multi-device access work?

This is one of the most important architectural questions because it touches both security and usability.

### Where salts and the encrypted DEK are stored

The following live on the **server database**, in the `users` table, in plaintext (they are safe to store in plaintext):

- `srp_salt` — used in the SRP login handshake
- `dek_salt` — used to re-derive the Master Key from the password on any device
- `encrypted_dek` — the DEK wrapped with the Master Key; useless without the password

These three values are intentionally not secret on their own. An attacker who steals all three still cannot decrypt anything without the user's password. The salt is designed to be public — its only job is to make each user's key derivation unique, not to add secrecy.

The DEK itself — the actual key that encrypts notes — is **never stored on the server in plaintext, ever**. It only exists in plaintext in the client's RAM during an active session.

### How multi-device access works

This is the key insight of the two-layer architecture:

1. Device A logs in. It fetches `dek_salt` and `encrypted_dek` from the server.
2. The user types their password on Device A.
3. Device A runs `PBKDF2(password, dek_salt)` → Master Key → decrypts `encrypted_dek` → DEK in memory.
4. Device A can now encrypt/decrypt notes.

Device B does the exact same thing independently. It fetches the same `dek_salt` and `encrypted_dek` from the server, the user types their password, and it derives the exact same DEK. Both devices end up with the same DEK in memory without that DEK ever being transmitted between them or stored anywhere in plaintext.

This is possible because key derivation is deterministic: the same password + the same salt always produces the same Master Key, which always unwraps the same DEK. The server just acts as storage for the encrypted wrapper — it never sees the unwrapped key.

### What "remember me" changes on a device

Without "remember me": the DEK exists only in RAM. Restart the browser, type password again.

With "remember me": the client generates a random device-specific secret, stores it in IndexedDB, and uses it to wrap the DEK a second time. This device-wrapped DEK is also stored in IndexedDB. On next visit, the client unwraps the DEK using the device secret — no password needed. This device-wrapped key never leaves the device and is unrelated to the server-stored `encrypted_dek`. Each device has its own independent device-wrapped copy.

If the user revokes a device from the settings page, the server can invalidate that device's session token. The device-wrapped key in IndexedDB becomes orphaned — it can still unwrap the DEK locally, but the device can no longer authenticate to the server to fetch or push notes. A full logout clears IndexedDB and destroys the device-wrapped key entirely.

### What happens if the user forgets their password

There is no password reset. This is intentional and unavoidable given the security model.

The DEK is derived from the password. If the password is lost, the Master Key cannot be reconstructed, the DEK cannot be unwrapped, and notes cannot be decrypted. The server cannot help — it never had the plaintext DEK. There is no "forgot password" email link that can restore access, because doing so would require the server to either store the DEK or reset it, both of which break E2EE.

The correct mitigation is: export your notes periodically as a backup, and store your password in a password manager. The app should make this extremely clear during registration.

A future option is a **recovery key** — a randomly generated code shown once at registration that can be used in place of a password to re-derive the DEK. The user must store it safely (e.g., printed out, in a safe). This is how iCloud Advanced Data Protection handles it.

---

## What if someone registers with the same username as an existing user?

The server enforces a `UNIQUE` constraint on the `username` column in PostgreSQL. If a registration request arrives with a username that already exists, the database rejects it and the server returns an error to the client. The registration fails — no account is created, no keys are generated.

The client should show a clear error: "That username is already taken."

There is no way to overwrite or collide with an existing account through the registration endpoint. The server-side uniqueness check happens atomically in the database, so even simultaneous registration attempts with the same username are handled safely (one succeeds, one gets the constraint violation error).

---

## Summary for Non-Technical Users

- **The server cannot read your notes.** Not the server operator, not a hacker who breaks into the server. Your notes are locked with your password before they leave your device.
- **Your password is never sent anywhere.** The app proves you know your password without telling the server what it is.
- **Even if someone intercepts your internet traffic, they get nothing.** Your notes are encrypted before they leave your device, independent of HTTPS.
- **If you log out, your device is clean.** Keys are wiped. Someone who finds your device after you log out cannot read your notes in Bedroc.
- **If your device has malware while you are logged in, you are not safe.** This is true for every secure app in existence.
- **There are no hidden trackers, analytics, or external services.** The app only talks to your own server.
- **You own your data.** Export it any time as JSON. If you delete your account, your data is gone — no one can recover it because no one ever had the keys. Even if you re-register with the same password, new random keys are generated — the old data cannot be recovered.
- **Two users with the same password cannot access each other's data.** Random salts ensure every account's keys are unique.
- **You can log in from any device.** Just enter your password — the app re-derives your keys on the spot. Nothing device-specific needs to be transferred.
- **If you forget your password, your notes are gone.** There is no recovery mechanism that doesn't break the encryption. Use a password manager. A recovery key option is planned.
- **Your password is the root of your security.** If someone steals the database AND you chose a weak password, they may eventually crack it with enough time and computing power. Use a strong, unique passphrase. The app will guide you. This is the one thing the software cannot fully protect you from — a truly weak password.
- **The upgrade from PBKDF2 to Argon2id (planned) dramatically hardens this last point.** After that upgrade, even a moderately weak password becomes very difficult to crack offline.
