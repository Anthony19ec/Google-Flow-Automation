# Flow Automation v1.0 🌊🤖

**Flow Automation** is a powerful Chrome Extension designed to streamline batch video and image generation on the **Google Flow AI** platform. It automates the tedious process of manual prompt entry, asset matching, and settings configuration, allowing you to generate hundreds of variants with a single click.

## 🚀 Key Features

- **Multi-Mode Support**: Automate Text-to-Video, Frame-to-Video, Ingredients-to-Video, Text-to-Image, and Image-to-Image.
- **Smart Settings Sync**: Automatically configures Model (Veo 3.1, Nano Banana), Aspect Ratio (16:9, 9:16, 4:3, 3:4), and Output Count.
- **Robust Queue Management**: 
    - Real-time status tracking with thumbnails.
    - Drag-and-drop reordering of assets.
    - Sorting by name or date.
- **Hardened Automation**: 
    - 15-minute persistent wait times for high-quality renders.
    - Smart error detection (skips policy errors, retries on server busy).
    - Native React input injection for guaranteed prompt delivery.
- **Self-Healing UI**: Automatically detects and mounts the side panel on Google Flow project pages.

## 🛠 Installation

1. Clone or Download this repository.
2. Open Google Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (top right toggle).
4. Click **Load unpacked** and select the project folder.
5. Navigate to [Google Flow](https://labs.google/fx/tools/flow) to start automating!

## 📖 How to Use

1. **Open a Project**: Navigate into a Google Flow project. The Flow Automation sidebar will appear on the right.
2. **Add Prompts**: Enter your prompts in the text area (one per line).
3. **Asset Matching**: If using image-based modes, upload your images. The extension matches them to prompts by name or order.
4. **Configure Settings**: Set your preferred model, aspect ratio, and output count in the Settings tab.
5. **▶ Run**: Click Run and watch the automation handle the rest. You can Stop or Clear the queue at any time.

## 📄 License
MIT License - Feel free to use and contribute!
