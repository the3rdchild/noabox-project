# ClimBox: Ocean and Freshwater Monitoring & Management Tool

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Firebase Hosting](https://img.shields.io/badge/Hosted%20on-Firebase-orange?style=flat-square)](https://firebase.google.com/products/hosting)

ClimBox is an innovative solution designed to support the preservation of marine and freshwater ecosystems through technology-driven data monitoring and management. It provides accurate and continuous environmental insights, making it an ideal tool for researchers, coastal communities, and conservation organizations.

---

## Quick Start

```bash
# Navigate to your project folder
cd /home/user/climbox-project/

# Install dependencies
npm i

# Firebase frontend host-view:
firebase emulators:start --only hosting
```

---

## Project File Structure

```
climbox-project
├── public
│   ├── assets
│   │   ├── data
│   │   ├── css
│   │   ├── fonts
│   │   ├── img
│   │   ├── js
│   │   │   ├── core
│   │   │   ├── plugins
│   │   │   ├── material-dashboard.js
│   │   │   ├── material-dashboard.js.map
│   │   │   └── material-dashboard.min.js
│   │   └── scss
│   │       ├── material-dashboard
│   │       └── material-dashboard.scss
│   ├── pages
│   │   ├── dashboard.html
│   │   ├── graph.html
│   │   ├── map.html
│   │   ├── notifications.html
│   │   ├── profile.html
│   │   ├── sign-in.html
│   │   ├── sign-up.html
│   │   └── tables.html
│   ├── data
│   │   ├── sensorData_2025-08-10.json
│   └── services
│   │   ├── auth.js
│   │   └── firestore.js
│   │   └── sensors.js
│   │   └── notifications.js
│   │   └── users.js
│   └── index.html
├── .gitignore
├── gulpfile.mjs
├── README.md
```
---

## Sensors

1. Water temp
2. EC/ Salinity
3. Water level
4. DO
5. pH
6. TDS
7. TSS
8. AIR TEMP & HUMIDITY
9. WIND SPEED & DIRECTION
10. CURAH HUJAN

---

## License

This project is licensed under the MIT License. See the [LICENSE](https://opensource.org/licenses/MIT) file for details.

