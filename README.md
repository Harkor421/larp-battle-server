<div align="center">

<img src="public/logo.png" alt="larp-battle-server" width="120" />

# larp-battle-server

### Duelos de flex por video 1:1, juzgados por una IA

![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black) ![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white) ![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white) ![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white) ![Express](https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white) ![WebSocket](https://img.shields.io/badge/WebSocket-1F2937?style=for-the-badge&logo=socketdotio&logoColor=white) ![MongoDB](https://img.shields.io/badge/MongoDB-47A248?style=for-the-badge&logo=mongodb&logoColor=white) ![Solana](https://img.shields.io/badge/Solana-9945FF?style=for-the-badge&logo=solana&logoColor=white) ![OpenAI](https://img.shields.io/badge/OpenAI-412991?style=for-the-badge&logo=openai&logoColor=white)

[**📦 Repositorio**](https://github.com/Harkor421/larp-battle-server)

</div>

---

## 📖 Sobre el proyecto

Backend de **Larp Battle**: batallas de flex tipo Omegle. Dos desconocidos se emparejan, cada uno tiene 2 minutos para mostrar sus cosas más valiosas por cámara, y GPT-4.1-mini identifica cada objeto, le pone precio y declara al ganador.

## ✨ Qué hace

- Emparejamiento aleatorio 1:1 y señalización WebRTC por WebSocket
- Video peer-to-peer: los navegadores se conectan directo (barato de escalar)
- Juez con GPT-4.1-mini que identifica y tasa cada objeto de los frames
- Bandera del país de cada jugador vía geolocalización por IP
- Leaderboard, perfiles, grabaciones y filtro de lenguaje · TURN propio con coturn

## 🧰 Stack

| | |
|---|---|
| **Lenguajes y runtime** | ![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black) ![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white) ![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white) ![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white) |
| **Backend** | ![Express](https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white) ![WebSocket](https://img.shields.io/badge/WebSocket-1F2937?style=for-the-badge&logo=socketdotio&logoColor=white) |
| **Datos** | ![MongoDB](https://img.shields.io/badge/MongoDB-47A248?style=for-the-badge&logo=mongodb&logoColor=white) |
| **Web3** | ![Solana](https://img.shields.io/badge/Solana-9945FF?style=for-the-badge&logo=solana&logoColor=white) |
| **IA** | ![OpenAI](https://img.shields.io/badge/OpenAI-412991?style=for-the-badge&logo=openai&logoColor=white) |

## 🚀 Empezar

```bash
git clone https://github.com/Harkor421/larp-battle-server.git
cd larp-battle-server
npm install
npm run dev
```

## ⚙️ Variables de entorno

Copia `.env.example` a `.env` y completa los valores:

| Variable | Ejemplo / valor por defecto |
|---|---|
| `PORT` | `3000` |
| `OPENAI_API_KEY` | `sk-...` |
| `JUDGE_MODEL` | `gpt-4.1-mini` |
| `TURN_HOST` | `turn.yourdomain.com` |
| `TURN_SECRET` | `change-me-openssl-rand-hex-32` |
| `TURN_TTL_SECONDS` | `3600` |
| `STUN_URLS` | `stun:stun.l.google.com:19302` |
| `BATTLE_DURATION_MS` | `60000` |
| `FRAME_INTERVAL_MS` | `1000` |
| `READY_TIMEOUT_MS` | `25000` |
| `TRUST_PROXY_HOPS` | `1` |
| `MAX_CONN_PER_IP` | `8` |
| `ALLOW_SAME_IP_MATCH` | `false` |
| `ADMIN_TOKEN` | — |
| `MAX_FRAME_BYTES` | `2000000` |
| `FRAME_MAX_EDGE` | `1280` |

## 📜 Scripts

| Comando | Qué hace |
|---|---|
| `npm run start` | Arranca la aplicación |
| `npm run dev` | Servidor de desarrollo con recarga en caliente |

---

<div align="center">

Hecho por [**Samir González**](https://github.com/Harkor421)

</div>
