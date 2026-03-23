// logic.js — Flow Automation Core Helpers (Production)

const Flow = {};

// ─── Localization ───
Flow.Locales = {
    en: {
        title: "Flow Automation", control: "Control", queue: "Queue", settings: "Setting",
        t2v: "Text to Video", i2v: "Frame to Video", c2v: "Ingredients to Video",
        t2i: "Text to Image", i2i: "Image to Image",
        start: "▶ Run", stop: "■ Stop", addQueue: "Add to Queue",
        clearQueue: "Clear All", remove: "Remove", pending: "Pending", running: "Running",
        done: "Done", failed: "Failed", retrying: "Retrying",
        concurrent: "Concurrent Prompts", delay: "Random Delay",
        concurrentSub: "Number of prompts to process simultaneously.",
        delaySub: "Random wait time before handling the next prompt.",
        uploadTitle: "Click to upload or drag & drop", uploadSub: "PNG, JPG, GIF up to 10MB each",
        promptLabel: "Prompts", txtUpload: "or upload .txt file",
        projectName: "Project Name", maxRetries: "Max Retries",
        dlVideo: "Auto Download Video", dlImage: "Auto Download Image",
        saveSettings: "Save Settings", imgProcess: "Image Processing Option",
        imgOpt1: "First and last frame images for each prompt", imgOpt2: "Single image per prompt",
        zoomNote: "Do not adjust zoom while running.", ready: "Ready", idle: "Idle",
        userGuide: "User Guide", language: "Language",
        videoModel: "Video Model", imageModel: "Image Model", aspectRatio: "Aspect Ratio",
        outputsPerPrompt: "Outputs per Prompt", videoFrame: "Video Frame Duration"
    },
    vi: {
        title: "Tự động hóa Flow", control: "Điều khiển", queue: "Hàng đợi", settings: "Cài đặt",
        t2v: "Văn bản → Video", i2v: "Khung hình → Video", c2v: "Thành phần → Video",
        t2i: "Văn bản → Hình ảnh", i2i: "Hình ảnh → Hình ảnh",
        start: "▶ Chạy", stop: "■ Dừng", addQueue: "Thêm vào hàng đợi",
        clearQueue: "Xóa tất cả", remove: "Xóa", pending: "Chờ", running: "Đang chạy",
        done: "Xong", failed: "Lỗi", retrying: "Thử lại",
        concurrent: "Số prompt đồng thời", delay: "Thời gian chờ ngẫu nhiên",
        concurrentSub: "Số lượng prompt xử lý cùng lúc.",
        delaySub: "Thời gian chờ ngẫu nhiên trước khi xử lý prompt tiếp theo.",
        uploadTitle: "Nhấp để tải lên hoặc kéo thả", uploadSub: "PNG, JPG, GIF tối đa 10MB mỗi file",
        promptLabel: "Prompts", txtUpload: "hoặc tải file .txt",
        projectName: "Tên dự án", maxRetries: "Số lần thử lại tối đa",
        dlVideo: "Tự động tải Video", dlImage: "Tự động tải Hình ảnh",
        saveSettings: "Lưu cài đặt", imgProcess: "Tùy chọn xử lý hình ảnh",
        imgOpt1: "Hình ảnh khung đầu và cuối cho mỗi prompt", imgOpt2: "Một hình ảnh cho mỗi prompt",
        zoomNote: "Không điều chỉnh thu phóng khi đang chạy.", ready: "Sẵn sàng", idle: "Rảnh",
        userGuide: "Hướng dẫn", language: "Ngôn ngữ",
        videoModel: "Mô hình Video", imageModel: "Mô hình Hình ảnh", aspectRatio: "Tỷ lệ khung hình",
        outputsPerPrompt: "Số đầu ra mỗi prompt", videoFrame: "Thời lượng khung hình"
    },
    zh: {
        title: "Flow 自动化", control: "控制", queue: "队列", settings: "设置",
        t2v: "文本生成视频", i2v: "帧生成视频", c2v: "组件生成视频",
        t2i: "文本生成图像", i2i: "图像生成图像",
        start: "▶ 运行", stop: "■ 停止", addQueue: "添加到队列",
        clearQueue: "清除所有", remove: "删除", pending: "等待中", running: "运行中",
        done: "完成", failed: "失败", retrying: "重试中",
        concurrent: "并发提示", delay: "随机延迟",
        concurrentSub: "同时处理的提示数量。",
        delaySub: "处理下一个提示前的随机等待时间。",
        uploadTitle: "点击上传或拖放", uploadSub: "PNG, JPG, GIF 每个最大10MB",
        promptLabel: "提示词", txtUpload: "或上传 .txt 文件",
        projectName: "项目名称", maxRetries: "最大重试次数",
        dlVideo: "自动下载视频", dlImage: "自动下载图像",
        saveSettings: "保存设置", imgProcess: "图像处理选项",
        imgOpt1: "每个提示的首尾帧图像", imgOpt2: "每个提示一张图像",
        zoomNote: "运行时请勿调整缩放。", ready: "就绪", idle: "空闲",
        userGuide: "用户指南", language: "语言",
        videoModel: "视频模型", imageModel: "图像模型", aspectRatio: "宽高比",
        outputsPerPrompt: "每个提示的输出数量", videoFrame: "视频帧时长"
    }
};

// ─── Prompt Parser ───
Flow.parsePrompts = (rawText) => {
    if (!rawText || !rawText.trim()) return [];
    return rawText.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
};

// ─── Asset Matching ───
Flow.matchAssets = (files, promptText) => {
    if (!files || files.length === 0 || !promptText) return [];
    const lower = promptText.toLowerCase();
    return Array.from(files).filter(f => {
        const stem = (f.name || "").split('.')[0].toLowerCase();
        return stem.length > 0 && lower.includes(stem);
    });
};

// ─── Filename Sanitizer ───
Flow.sanitizeFilename = (prompt, ext = "mp4") => {
    if (!prompt) return `gen_${Date.now()}.${ext}`;
    const clean = prompt.substring(0, 30).replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').toLowerCase();
    return `${clean}_${Date.now()}.${ext}`;
};

// ─── Storage Manager ───
Flow.Storage = {
    get: (key, fallback) => new Promise(resolve => {
        chrome.storage.local.get([key], r => resolve(chrome.runtime.lastError || r[key] === undefined ? fallback : r[key]));
    }),
    set: (key, val) => new Promise(resolve => {
        chrome.storage.local.set({ [key]: val }, resolve);
    })
};

// ─── Default Settings ───
Flow.DEFAULTS = {
    defaultMode: 't2v',
    defaultAspect: '16:9',
    outputsPerPrompt: 1,
    maxConcurrent: 1,
    delayMin: 20,
    delayMax: 30,
    videoModel: 'veo_3_1_fast',
    imageModel: 'nano_banana_2',
    downloadVideoQuality: '1080p',
    downloadImageQuality: '4k',
    projectName: 'flow_project',
    maxRetries: 20,
    defaultVideoFrame: '8s',
    maxImagesPerPrompt: 2,
    language: 'en'
};

// ─── Random Delay ───
Flow.getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

window.Flow = Flow;
