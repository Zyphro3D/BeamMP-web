# 🚗 BeamMP-Web – Web Management Interface for BeamMP Servers

> ⚠️ **This branch holds V1 (PHP/MariaDB), which is no longer maintained.**
> The current version is **V2** (Node.js/TypeScript + PostgreSQL, Docker):
> branch [`v2`](https://github.com/Zyphro3D/BeamMP-web/tree/v2) —
> [latest release](https://github.com/Zyphro3D/BeamMP-web/releases/latest).
> A V1 → V2 migration tool is included (`scripts/migrate-v1-to-v2.mjs`).

![Interface Preview](./docs/beammp-web.jpg)

---

## 🚀 Updates

- **2025-07-27:** Complete app overhaul – now supports multi-instances, automatic install script, and bot compilation.
- **2025-07-19:** Standardized folder naming (`inactive_map`, `inactive_mod`) in scripts and docs.
- **2025-07-19:** Cleaned up the documentation, multi-language installation guides available below.

---

## ⚒️ Work in Progress

- ~~Full installation script (automated setup from scratch)~~ ✅  
- ~~Custom web port selection during setup~~ ✅  
- ~~Multi-instance support (host several BeamMP-Web panels independently)~~ ✅  
- ✅ ARM compatibility (Raspberry Pi & ARM servers) – **functional, awaiting feedback**
- Work in progress on a script to automatically insert into the database all mods that are already present on the server.
---

## 🌐 What is BeamMP-Web?

**BeamMP-Web** is a lightweight, multilingual, and secure web interface to manage your **BeamMP server** from any browser – local or remote.  
It simplifies server administration while giving you full control over mods, maps, configs, and the server state.

Perfect for public hosts and private games alike, **BeamMP-Web** brings everything together into one clean dashboard.

---

## ✨ Features

- 🔐 Secure login system  
- 🌍 Works over local **HTTP** or **HTTPS** with your custom domain  
  > ⚠️ Webhook images may not display in HTTP local mode  
- 📦 Add/remove **mods**, **maps**, and **vehicles**  
- ✅ Enable/disable individual mods and vehicles (click image to toggle; greyed out = disabled)  
- 🗺️ Switch maps (requires restart)  
- 📄 View **BeamMP server logs** directly in the interface  
- ⚙️ Edit the `serverConfig.toml` file  
- 📣 Connection/disconnection webhooks with custom rank system  
- 📊 Live server status webhook (refresh feedback)  
- 🔁 Webhook triggered when a mod is uploaded via the web interface  

---

## ⚙️ Quick Installation

1. Install required dependencies  
2. Create the database user and set privileges  
3. Make the install script executable  
4. Launch the script… and follow the guide 😄  

---

## 📚 Documentation

- [English Install Guide](./docs/INSTALL_EN.md)  
- [French Install Guide](./docs/INSTALL_FR.md)  
- [German Install Guide](./docs/INSTALL_DE.md)  

---

## 🤝 Contributors

Thanks to everyone contributing to this project!  
Full list available in the [CONTRIBUTORS](./CONTRIBUTORS.md) file.

---

## 👤 Author

Project maintained by **[Zyphro3D](https://github.com/Zyphro3D)**  
Suggestions, improvements, and community feedback welcome!

---

## 📝 License

MIT License – Free to use, just keep the credits 🙌  
- ☕ [Buy me a coffee on Ko-fi](https://ko-fi.com/zyphro3D)
