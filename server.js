const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5001;
const HOST = process.env.HOST || 'localhost';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || 'avp_whatsapp_secure_gateway_token_12345';
const CRM_WEBHOOK_URL = process.env.CRM_WEBHOOK_URL;
const CRM_API_TOKEN = process.env.CRM_API_TOKEN;
const SESSION_PATH = process.env.SESSION_PATH || './session';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Global State
let connectionStatus = 'DISCONNECTED'; // DISCONNECTED, INITIALIZING, QR_READY, CONNECTED
let qrCodeImage = null; // Base64 data URL
let qrCodeRaw = null;
let client = null;

// Security Middleware
const authenticate = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey || apiKey !== GATEWAY_API_KEY) {
        return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or missing API key' });
    }
    next();
};

// Webhook Helper
const triggerWebhook = async (event, data) => {
    if (!CRM_WEBHOOK_URL) {
        console.log('[Webhook] Webhook URL not configured, skipping.');
        return;
    }
    try {
        console.log(`[Webhook] Triggering event: ${event}`);
        await axios.post(CRM_WEBHOOK_URL, {
            event,
            data,
            timestamp: new Date().toISOString()
        }, {
            headers: {
                'Content-Type': 'application/json',
                'X-CRM-API-Token': CRM_API_TOKEN
            },
            timeout: 5000
        });
    } catch (error) {
        console.error(`[Webhook Error] Failed to notify CRM for event ${event}:`, error.message);
    }
};

// Initialize WhatsApp Client
const initializeClient = () => {
    if (client) {
        console.log('[Client] Client already exists. Skipping initialization.');
        return;
    }

    console.log('[Client] Starting initialization...');
    connectionStatus = 'INITIALIZING';
    qrCodeImage = null;
    qrCodeRaw = null;

    const puppeteerOptions = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    };

    if (process.env.CHROME_PATH || fs.existsSync('/usr/bin/google-chrome-stable')) {
        puppeteerOptions.executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';
    } else if (fs.existsSync('/usr/bin/google-chrome')) {
        puppeteerOptions.executablePath = '/usr/bin/google-chrome';
    }

    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: SESSION_PATH
        }),
        puppeteer: puppeteerOptions
    });

    client.on('qr', async (qr) => {
        console.log('[Client] QR Code generated!');
        qrCodeRaw = qr;
        connectionStatus = 'QR_READY';
        try {
            qrCodeImage = await qrcode.toDataURL(qr);
            triggerWebhook('status_change', { status: 'QR_READY', qr: qrCodeImage });
        } catch (err) {
            console.error('[Client] Error generating QR code image:', err);
        }
    });

    client.on('ready', () => {
        console.log('[Client] WhatsApp is ready!');
        connectionStatus = 'CONNECTED';
        qrCodeImage = null;
        qrCodeRaw = null;
        triggerWebhook('status_change', { status: 'CONNECTED', info: client.info });
    });

    client.on('authenticated', () => {
        console.log('[Client] Authenticated successfully');
    });

    client.on('auth_failure', (msg) => {
        console.error('[Client] Authentication failure:', msg);
        connectionStatus = 'DISCONNECTED';
        triggerWebhook('status_change', { status: 'DISCONNECTED', error: msg });
    });

    client.on('disconnected', (reason) => {
        console.log('[Client] Disconnected:', reason);
        connectionStatus = 'DISCONNECTED';
        qrCodeImage = null;
        qrCodeRaw = null;
        triggerWebhook('status_change', { status: 'DISCONNECTED', reason });
        
        // Destroy client reference
        destroyClient();
    });

    // Capture incoming and outgoing messages
    client.on('message', async (msg) => {
        // Exclude status updates and broadcast messages
        if (msg.key && msg.key.remoteJid === 'status@broadcast') return;
        
        console.log(`[Client] Inbound message from ${msg.from}`);
        handleMessage(msg);
    });

    // Capture messages sent from phone or gateway (outbox sync)
    client.on('message_create', async (msg) => {
        if (msg.key && msg.key.remoteJid === 'status@broadcast') return;
        
        // If it's a message created by us, send it to the CRM so the CRM inbox stays synced!
        if (msg.fromMe) {
            console.log(`[Client] Outbound message created from this account to ${msg.to}`);
            handleMessage(msg);
        }
    });

    client.initialize().catch(err => {
        console.error('[Client] Initialization error:', err);
        connectionStatus = 'DISCONNECTED';
    });
};

// Handle and format message details to send to CRM
const handleMessage = async (msg) => {
    let mediaData = null;
    if (msg.hasMedia) {
        try {
            const media = await msg.downloadMedia();
            if (media) {
                mediaData = {
                    mimetype: media.mimetype,
                    data: media.data, // base64 representation
                    filename: media.filename || 'attachment'
                };
            }
        } catch (err) {
            console.error('[Client] Failed to download media:', err.message);
        }
    }

    triggerWebhook('message', {
        id: msg.id._serialized,
        from: msg.from,
        to: msg.to,
        body: msg.body,
        fromMe: msg.fromMe,
        timestamp: msg.timestamp,
        hasMedia: msg.hasMedia,
        media: mediaData,
        deviceType: msg.deviceType
    });
};

const destroyClient = async () => {
    if (client) {
        try {
            await client.destroy();
        } catch (e) {
            console.error('[Client] Error during client destroy:', e.message);
        }
        client = null;
    }
};

// Automatically try to initialize client on startup to restore session if exists
initializeClient();

// --- API ROUTES ---

// GET /status - Fetch current connection status
app.get('/status', authenticate, (req, res) => {
    res.json({
        success: true,
        status: connectionStatus,
        hasSession: fs.existsSync(path.join(SESSION_PATH, 'Default'))
    });
});

// GET /qr - Fetch current QR Code base64 image
app.get('/qr', authenticate, (req, res) => {
    if (connectionStatus === 'QR_READY' && qrCodeImage) {
        res.json({ success: true, qr: qrCodeImage, raw: qrCodeRaw });
    } else {
        res.json({
            success: false,
            status: connectionStatus,
            error: 'QR code not available. Status must be QR_READY.'
        });
    }
});

// POST /send-message - Send textual message
app.post('/send-message', authenticate, async (req, res) => {
    const { to, message } = req.body;

    if (!to || !message) {
        return res.status(400).json({ success: false, error: 'Missing parameters: "to" and "message" are required.' });
    }

    if (connectionStatus !== 'CONNECTED' || !client) {
        return res.status(503).json({ success: false, error: 'WhatsApp client is not connected.' });
    }

    try {
        // Sanitize phone number: strip non-numeric characters and format for whatsapp
        let formattedNumber = to.replace(/\D/g, '');
        if (!formattedNumber.endsWith('@c.us')) {
            formattedNumber = `${formattedNumber}@c.us`;
        }

        const sentMsg = await client.sendMessage(formattedNumber, message);
        res.json({
            success: true,
            messageId: sentMsg.id._serialized,
            status: 'sent'
        });
    } catch (err) {
        console.error('[API] Error sending message:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /send-media - Send media (image, video, document)
app.post('/send-media', authenticate, async (req, res) => {
    const { to, file, filename, mimetype, caption } = req.body;

    if (!to || !file || !mimetype) {
        return res.status(400).json({
            success: false,
            error: 'Missing parameters: "to", "file" (base64 string), and "mimetype" are required.'
        });
    }

    if (connectionStatus !== 'CONNECTED' || !client) {
        return res.status(503).json({ success: false, error: 'WhatsApp client is not connected.' });
    }

    try {
        let formattedNumber = to.replace(/\D/g, '');
        if (!formattedNumber.endsWith('@c.us')) {
            formattedNumber = `${formattedNumber}@c.us`;
        }

        // Create MessageMedia object from base64 string
        const media = new MessageMedia(mimetype, file, filename || 'media');
        const options = {};
        if (caption) {
            options.caption = caption;
        }

        const sentMsg = await client.sendMessage(formattedNumber, media, options);
        res.json({
            success: true,
            messageId: sentMsg.id._serialized,
            status: 'sent'
        });
    } catch (err) {
        console.error('[API] Error sending media:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /disconnect - Terminate WhatsApp session and log out
app.post('/disconnect', authenticate, async (req, res) => {
    console.log('[API] Disconnect requested');
    try {
        if (client) {
            if (connectionStatus === 'CONNECTED') {
                await client.logout();
            }
            await destroyClient();
        }
        
        connectionStatus = 'DISCONNECTED';
        qrCodeImage = null;
        qrCodeRaw = null;

        // Clean session folder manually to make sure no lock files remain
        if (fs.existsSync(SESSION_PATH)) {
            try {
                fs.rmSync(SESSION_PATH, { recursive: true, force: true });
                console.log('[Client] Session folder deleted.');
            } catch (err) {
                console.error('[Client] Failed to delete session folder:', err.message);
            }
        }

        res.json({ success: true, message: 'Logged out and session cleared.' });
    } catch (err) {
        console.error('[API] Error during disconnect:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /reconnect - Force client reinitialization
app.post('/reconnect', authenticate, async (req, res) => {
    console.log('[API] Reconnect requested');
    try {
        await destroyClient();
        connectionStatus = 'DISCONNECTED';
        qrCodeImage = null;
        qrCodeRaw = null;
        
        initializeClient();
        res.json({ success: true, message: 'Reinitialization started.' });
    } catch (err) {
        console.error('[API] Error during reconnect:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Start Server
app.listen(PORT, HOST, () => {
    console.log(`[Gateway] Server is running on http://${HOST}:${PORT}`);
});
