# Bedroc -- A secure, Private, End-to-End Encrypted Real Time Syncing Multi-Platform Notes Site/App.

Public instance Self-hostable by everyone, either through a tailscale-like vpn mesh or by owning a
public ip source, such as a VPS, open source.
Private notes site/PWA with authentication and end to end encryption (military grade).
Use locally hosted (or vps hosted) PRIVATE database for storing data, not 3rd party services.
Self hosted, open source and self-hostable by everyone, private, includes all necessary features, like
notion or google keep etc. most minimal and basic core feature is a notepad feature and e2ee (maybe key derived from password hash? passwords are also never stored as plain text in anywhere.) cross-device sharing.
Simple and reliable at first, more advanced features (like markdown formatting, settings, advanced text formatting, file insertions [uploaded files should also get encrypted] etc.) later. If 3rd party services are used, keep them privacy friendly.
Encrypt data on send in client before sending, decrypt on end devices. Use safe keys.
indexeddb for offline use, pwa and browser support on all platforms. IOS, android, windows, macos, linux, etc.
use service workers for offline support and sync when back online. encryption keys should never leave the client, and should be stored securely on the client.
syncing should be done in a way that doesn't cause conflicts, and should be able to handle conflicts gracefully if they do occur.
server shouldnt have access to the data, and should only be used for syncing and storing encrypted data.
for pwas, especially ios, use a manifest and all necessary features to make it installable and work well as a pwa.
prevent rubberbanding and other ios specific issues with pwas. make sure it works well on all platforms and browsers, with a focus on privacy and security.
prevent ios text field and input field zooming issues. make sure the app is responsive and works well on all screen sizes. for fields that users can click on, use font size 16px or larger to prevent zooming issues on ios. use meta tags and other techniques to prevent zooming issues on ios.
prevent whole app container scrolling up and down when keyboard is open on ios. use techniques to prevent this, such as preventing default behavior on focus and blur events, and using fixed positioning for the app container. make sure the app is usable and doesn't have any issues on ios when the keyboard is open.
also prevent whole app scrolling up and down when user drags a non scrollable area on ios. use techniques to prevent this, such as preventing default behavior on touchmove events, and using overflow hidden for non scrollable areas. make sure the app is usable and doesn't have any issues on ios when user drags a non scrollable area.
also prevent data loss in case of uninstallation by keeping data in indexeddb and allowing export of data as json or other formats. ( warn of security risks, exported data is not encrypted and should be kept safe by the user.)


- use whatever stack, but I used react way too much and want to learn something else, so maybe use the next best thing for such a project. I want to later be able to turn this into an electronjs app for windows macos and linux. other than that the main goal for now is a functioning multi-platform responsive website that can be used seamlessly as a PWA added to homescreen, on mobiles, as well as browsers in any device.

## ALL code should be well documented, update the documentation if you update a page, function, etc. documentation must be up-to-date.
## PRIVACY AND SECURITY ARE OF UTMOST IMPORTANCE. ANY FUNCTIONALITY COMES AFTER THOSE TWO ARE MET PERFECTLY. MAKE IT EXTREMELY HARD TO HACK, BRUTE FORCE, BOT, DOS. EVEN IF COMPROMISED, IMPLEMENT THE ENCRYPTION E2EE USING THE BEST PRACTICES SO THAT NO INFO CAN BE INTERCEPTED BY HACKERS. USE POST-QUANTUM COMPUTING LEVEL ENCRYPTION FOR FUTURE-PROOFING. MAKE SECURE LOGINS AND LOGOUTS SO NO TRACE IS LEFT ON THE DEVICE AFTER LOGOUT, CLEARING ANY POSSIBLE STORED KEYS. USE THE ABSOLUTE SAFEST ENCRYPTION, WITHOUT SACRIFICING CONVENIENCE.
## AVOID USING THIRD PARTY APIS AND EXTERNAL DEPENDENCIES. ANYONE WHO PULLS THIS REPO SHOULD BE ABLE TO USE THIS CODE, WITHOUT INTERNET ACCESS, EXCEPT FOR THE OBVIOUS NOTE SYNCING AND SERVER ACCESS PART. SO IF USING CDN, HOST IT LOCALLY AFTER DOWNLOADING INSTEAD. THIRD PARTY API? AVOID UNLESS VERY STRICTLY NECESSARY. EVEN IF APIS ARE USED, NO PERSONAL OR NOTE DATA SHOULD EVER BE SENT.
## SINCE THIS PROJECT IS MEANT TO BE HOSTED BY PEOPLE WHO USE IT, GIVE DOCKER/VPN/FIREWALL CONFIG SETTINGS TOO, IN A 'GUIDE.md'. EXPLAIN WHAT TO DO, GIVE EXAMPLES FOR TAILSCALE (if behind cgnat), AND WIREGUARD/UFW IF USER HAS A PUBLIC IP OR VPS.