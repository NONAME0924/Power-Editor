# Power Editor — Professional Web Video Editor
# Power Editor — 專業級網頁影片剪輯工具

A professional browser-based video editing tool with a high-performance timeline, Edge TTS integration, and local MP4 export capabilities.
一款基於瀏覽器的專業影片剪輯工具，具備高效能時間軸、Edge TTS 語音合成以及本地 MP4 匯出功能。

---

## 🚀 Features | 功能特色

- **Professional Timeline | 專業時間軸**
  - Multi-track editing (Video & Audio) | 多軌剪輯（影片與音軌）
  - Precise split tool with frame-level accuracy | 影格級精準分割工具
  - **Auto-Stretch Mode | 自動時間伸縮**: Drag clips beyond their original length to automatically slow them down (Time Stretching) without revealing unwanted content. | 拖拉片段超出長度時自動變為慢動作，不露出未剪輯內容。
- **High Performance | 高效能體驗**
  - Canvas-based preview engine for smooth scrubbing | 基於 Canvas 的高效預覽，拖動極致流暢
  - Local processing to ensure privacy and speed | 本地端處理，兼顧隱私與速度
- **Advanced Tools | 進階工具**
  - Integrated Edge TTS (Text-to-Speech) | 內建 Edge TTS 語音合成
  - Frame-accurate manual time input | 精確秒數手動定位
- **Local Export | 本地匯出**
  - Powered by FFmpeg for high-quality MP4 rendering | 使用 FFmpeg 進行高品質 MP4 渲染

---

## 🛠️ Tech Stack | 技術架構

- **Frontend**: Vanilla JS, HTML5 Canvas, Modern CSS (Glassmorphism UI)
- **Backend**: Node.js, Express
- **Core Engine**: FFmpeg (for exporting), Edge TTS (for voice synthesis)

---

## 📦 Installation | 安裝步驟

### Prerequisites | 系統需求
- **Node.js**: v22 or later
- **FFmpeg**: Must be installed and added to your system's PATH. | 必須安裝並加入系統環境變數。

### Setup | 開始使用
1. Clone the repository | 複製專案
   ```bash
   git clone https://github.com/your-username/local-power-editor.git
   cd local-power-editor
   ```
2. Install dependencies | 安裝套件
   ```bash
   npm install
   ```
3. Start the server | 啟動伺服器
   ```bash
   npm start
   ```
4. Open your browser and go to `http://localhost:3000` | 打開瀏覽器訪問 `http://localhost:3000`

---

## ⚖️ License & Disclosures | 授權說明

### Project License
This project is licensed under the **MIT License**. See the `LICENSE` file for details.

### Third-Party Licenses
- **edge-tts**: Licensed under the [MIT License](https://github.com/rany2/edge-tts).
- **FFmpeg**: This project interacts with FFmpeg via command line. FFmpeg is licensed under the **LGPL v2.1+ / GPL v2+**. 
  - *Note: This project does not distribute FFmpeg binaries. Users are responsible for their own FFmpeg installation.*

---

## 📝 Author | 作者
Created with ❤️ by Antigravity (Advanced Agentic Coding AI).

---

### 中文簡介 (ZH)
這是一個為創作者設計的本地化影片剪輯解決方案。它解決了網頁影片剪輯中常見的效能與隱私問題，並提供了專業剪輯軟體（如 PowerDirector）的操作手感。
特別是針對「精準分割」與「自動拉伸」進行了優化，適合快速製作帶有 AI 旁白的教學影片或短片。
