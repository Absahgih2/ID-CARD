const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const XLSX = require('xlsx');
const JSZip = require('jszip');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'printdigi001@gmail.com';
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

// Directories
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads', 'photos');
const dbFilePath = path.join(dataDir, 'students.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

function readLocalDB() {
  try {
    if (fs.existsSync(dbFilePath)) {
      return JSON.parse(fs.readFileSync(dbFilePath, 'utf8'));
    }
  } catch (err) {}
  return { students: [], lastBatchTimestamp: null };
}

function writeLocalDB(data) {
  fs.writeFileSync(dbFilePath, JSON.stringify(data, null, 2), 'utf8');
}

// Helper to make HTTPS requests to Google Apps Script (Handles redirects correctly)
function makeRequest(url, method, payload = null) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      // Handle redirect: Google Apps Script redirects a POST to a GET URL to fetch the result.
      if (res.statusCode === 302 || res.statusCode === 301 || res.statusCode === 307) {
        return makeRequest(res.headers.location, 'GET', null).then(resolve).catch(reject);
      }

      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(body);
        }
      });
    });

    req.on('error', (err) => reject(err));

    if (payload && method === 'POST') {
      req.write(JSON.stringify(payload));
    }
    req.end();
  });
}

// --- DATABASE & DRIVE SYNC HELPERS ---

async function syncDB() {
  if (APPS_SCRIPT_URL) {
    try {
      const db = await makeRequest(APPS_SCRIPT_URL, 'GET');
      if (db && Array.isArray(db.students)) {
        writeLocalDB(db);
        return db;
      }
    } catch (err) {
      console.error("❌ Google Apps Script DB read error, using local database cache:", err.message);
    }
  }
  return readLocalDB();
}

async function saveDB(dbData) {
  writeLocalDB(dbData);
  if (APPS_SCRIPT_URL) {
    try {
      await makeRequest(APPS_SCRIPT_URL, 'POST', {
        action: 'save_db',
        db: dbData
      });
      console.log("☁️ Database updated on Google Drive via Apps Script.");
    } catch (err) {
      console.error("❌ Google Apps Script DB write error:", err.message);
    }
  }
}

async function uploadPhoto(localPath, filename) {
  if (APPS_SCRIPT_URL) {
    try {
      const fileBuffer = fs.readFileSync(localPath);
      const base64File = fileBuffer.toString('base64');
      const ext = path.extname(localPath).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';

      const uploadResult = await makeRequest(APPS_SCRIPT_URL, 'POST', {
        action: 'upload_photo',
        filename: filename,
        mimeType: mimeType,
        base64: base64File
      });

      if (uploadResult && uploadResult.success) {
        console.log(`☁️ Uploaded photo to Google Drive: ${filename}`);
        try { fs.unlinkSync(localPath); } catch (e) {}
        return uploadResult;
      } else {
        console.error("❌ Google Apps Script upload failed:", uploadResult.error);
      }
    } catch (err) {
      console.error("❌ Photo upload to Apps Script failed:", err.message);
    }
  }
  return null;
}

async function deletePhoto(fileId) {
  if (APPS_SCRIPT_URL && fileId) {
    try {
      await makeRequest(APPS_SCRIPT_URL, 'POST', {
        action: 'delete_file',
        fileId: fileId
      });
      console.log(`☁️ Deleted file from Google Drive via Apps Script: ${fileId}`);
    } catch (e) {
      console.error("❌ Delete photo from Apps Script failed:", e.message);
    }
  }
}

// Multer Storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const sanitizeName = (req.body.studentName || 'STUDENT').toUpperCase().replace(/[^A-Z0-9_-]/g, '_');
    const customId = `STU-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    req.generatedStudentId = customId;
    req.generatedFilename = `${sanitizeName}_${customId}${ext}`;
    cb(null, req.generatedFilename);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files (JPG, PNG, WEBP) are allowed!'), false);
  }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads/photos', express.static(uploadsDir));

// SSE Real-time Alerts
let sseClients = [];
function broadcastSSE(eventData) {
  sseClients.forEach(client => client.res.write(`data: ${JSON.stringify(eventData)}\n\n`));
}

app.get('/api/notifications/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// --- GOOGLE DRIVE DIAGNOSTICS ENDPOINT ---
app.get('/api/diagnostics/drive', async (req, res) => {
  if (!APPS_SCRIPT_URL) {
    return res.json({ 
      success: true, 
      folderName: 'Local Server Cache (E:\\Coding\\ID Card Generation\\data)',
      folderId: 'Local Disk'
    });
  }

  try {
    const testResult = await makeRequest(APPS_SCRIPT_URL, 'POST', {
      action: 'diagnostics'
    });

    if (testResult && testResult.success) {
      res.json({
        success: true,
        message: 'Connected to Google Drive with full Read/Write permissions!',
        folderName: testResult.folderName,
        folderId: testResult.folderId
      });
    } else {
      const errorMsg = typeof testResult === 'object' 
        ? (testResult.error || JSON.stringify(testResult)) 
        : String(testResult).substring(0, 150);
        
      res.status(500).json({
        success: false,
        error: `Apps Script response error: ${errorMsg}`
      });
    }
  } catch (err) {
    res.status(500).json({
      success: false,
      error: `Failed to connect to Google Apps Script Web App: ${err.message}`
    });
  }
});

// --- DAILY 4:00 PM EMAIL SUMMARY ENGINE ---
async function sendDailySummaryEmail() {
  const db = await syncDB();
  const students = db.students || [];

  const todayStr = new Date().toISOString().split('T')[0];
  const todayStudents = students.filter(s => {
    const sDate = new Date(s.submittedAt).toISOString().split('T')[0];
    return sDate === todayStr;
  });

  const count = todayStudents.length;
  console.log(`[Cron 4:00 PM] Daily email check: ${count} student submission(s) today.`);

  const classBreakdown = {};
  todayStudents.forEach(s => {
    classBreakdown[s.className] = (classBreakdown[s.className] || 0) + 1;
  });

  const classRows = Object.keys(classBreakdown).map(cls => `
    <tr>
      <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Class ${cls}</td>
      <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${classBreakdown[cls]} Students</td>
    </tr>
  `).join('');

  const emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 10px;">
      <h2 style="color: #4f46e5; margin-bottom: 5px;">📊 Daily Student ID Card Submission Report</h2>
      <p style="color: #64748b; font-size: 0.9rem; margin-top: 0;">Date: <strong>${new Date().toLocaleDateString()}</strong> | Scheduled 4:00 PM Report</p>
      
      <div style="background: #f1f5f9; padding: 15px; border-radius: 8px; margin: 20px 0;">
        <h3 style="margin: 0; color: #0f172a;">Total Submissions Today: <span style="color: #10b981; font-size: 1.5rem;">${count}</span></h3>
      </div>

      ${count > 0 ? `
        <h4 style="color: #334155;">Class-wise Breakdown:</h4>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
          <thead>
            <tr style="background: #e2e8f0;">
              <th style="padding: 8px; border: 1px solid #cbd5e1; text-align: left;">Class</th>
              <th style="padding: 8px; border: 1px solid #cbd5e1; text-align: center;">Submissions</th>
            </tr>
          </thead>
          <tbody>
            ${classRows}
          </tbody>
        </table>
      ` : '<p style="color: #94a3b8;">No new student submissions recorded today.</p>'}

      <div style="margin-top: 25px; text-align: center;">
        <a href="https://id-card-bkgx.onrender.com/admin.html" style="background: #4f46e5; color: #fff; text-decoration: none; padding: 12px 25px; border-radius: 6px; font-weight: bold; display: inline-block;">
          Open Admin Panel to Download Excel & Photos ➔
        </a>
      </div>
    </div>
  `;

  const emailUser = process.env.EMAIL_USER;
  const emailPass = process.env.EMAIL_PASS;

  if (emailUser && emailPass) {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: emailUser, pass: emailPass }
    });

    try {
      await transporter.sendMail({
        from: `"ID Card Collector" <${emailUser}>`,
        to: NOTIFY_EMAIL,
        subject: `📊 Daily ID Card Report: ${count} Submission(s) Today (${new Date().toLocaleDateString()})`,
        html: emailHtml
      });
      console.log(`✅ Daily 4:00 PM report email successfully sent to ${NOTIFY_EMAIL}!`);
      return { success: true, message: `Email sent to ${NOTIFY_EMAIL}` };
    } catch (err) {
      console.error(`❌ Error sending daily email:`, err.message);
      return { success: false, error: err.message };
    }
  } else {
    console.log(`ℹ️ Email SMTP credentials not configured. Set EMAIL_USER & EMAIL_PASS.`);
    return { success: true, message: `Report generated for ${count} student(s) today.` };
  }
}

cron.schedule('0 16 * * *', () => {
  console.log('⏰ Executing 4:00 PM Daily Email Summary Cron Job...');
  sendDailySummaryEmail();
});

app.post('/api/notifications/send-daily-email', async (req, res) => {
  const result = await sendDailySummaryEmail();
  res.json(result);
});

// API Routes
app.get('/api/students', async (req, res) => {
  const db = await syncDB();
  const students = db.students || [];

  const total = students.length;
  const generated = students.filter(s => s.status === 'Generated').length;
  const pending = students.filter(s => s.status === 'Pending').length;

  const lastBatchTime = db.lastBatchTimestamp ? new Date(db.lastBatchTimestamp).getTime() : 0;
  const lateCount = students.filter(s => s.status === 'Pending' && new Date(s.submittedAt).getTime() > lastBatchTime).length;

  res.json({
    students,
    summary: { total, generated, pending, lateCount, lastBatchTimestamp: db.lastBatchTimestamp }
  });
});

app.post('/api/students/submit', upload.single('photo'), async (req, res) => {
  try {
    const { studentName, className, dob, fatherName, contact1, contact2, address } = req.body;

    if (!studentName || !className || !dob || !fatherName || !contact1 || !address || !req.file) {
      return res.status(400).json({ error: 'Student Name, Class, DOB, Father Name, Primary Contact, Address, and Photo are mandatory!' });
    }

    const photoFilename = req.file.filename;
    const tempLocalPath = req.file.path;

    // Upload photo to Google Drive (via Apps Script)
    const drivePhoto = await uploadPhoto(tempLocalPath, photoFilename);
    const driveFileId = drivePhoto ? drivePhoto.fileId : '';
    const photoPath = drivePhoto ? drivePhoto.webViewLink : `/uploads/photos/${photoFilename}`;

    const db = await syncDB();

    const studentRecord = {
      id: req.generatedStudentId || `STU-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      studentName: studentName.trim().toUpperCase(),
      className: className.trim().toUpperCase(),
      dob: dob.trim().toUpperCase(),
      fatherName: fatherName.trim().toUpperCase(),
      contact1: contact1.trim().toUpperCase(),
      contact2: contact2 ? contact2.trim().toUpperCase() : '',
      address: address.trim().toUpperCase(),
      photoFilename,
      photoPath,
      driveFileId,
      status: 'Pending',
      submittedAt: new Date().toISOString()
    };

    db.students.push(studentRecord);
    await saveDB(db);

    const updatedPending = db.students.filter(s => s.status === 'Pending').length;
    const lastBatchTime = db.lastBatchTimestamp ? new Date(db.lastBatchTimestamp).getTime() : 0;
    const lateCount = db.students.filter(s => s.status === 'Pending' && new Date(s.submittedAt).getTime() > lastBatchTime).length;

    broadcastSSE({
      type: 'NEW_SUBMISSION',
      message: `NEW STUDENT REGISTRATION: ${studentRecord.studentName} (${studentRecord.className})`,
      student: studentRecord,
      summary: {
        total: db.students.length,
        pending: updatedPending,
        generated: db.students.filter(s => s.status === 'Generated').length,
        lateCount
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Student information and photo submitted successfully!',
      student: studentRecord
    });
  } catch (err) {
    console.error("Submission Error:", err);
    return res.status(500).json({ error: 'Server error processing submission: ' + err.message });
  }
});

app.post('/api/students/batch-status', async (req, res) => {
  const { ids, status } = req.body;
  if (!Array.isArray(ids) || !ids.length || !['Pending', 'Generated'].includes(status)) {
    return res.status(400).json({ error: 'Invalid batch parameters.' });
  }

  const db = await syncDB();
  let updatedCount = 0;

  db.students = db.students.map(s => {
    if (ids.includes(s.id)) {
      updatedCount++;
      return { ...s, status };
    }
    return s;
  });

  if (status === 'Generated') db.lastBatchTimestamp = new Date().toISOString();

  await saveDB(db);

  broadcastSSE({
    type: 'STATUS_UPDATED',
    message: `Updated ${updatedCount} student(s) to status: ${status}`,
    updatedIds: ids,
    newStatus: status
  });

  res.json({
    success: true,
    message: `Successfully updated ${updatedCount} students to '${status}'.`,
    lastBatchTimestamp: db.lastBatchTimestamp
  });
});

app.post('/api/students/batch-delete', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'Please select at least one student to delete.' });
  }

  const db = await syncDB();
  const initialCount = db.students.length;

  for (const s of db.students) {
    if (ids.includes(s.id)) {
      if (s.driveFileId) await deletePhoto(s.driveFileId);
    }
  }

  db.students = db.students.filter(s => !ids.includes(s.id));
  await saveDB(db);

  broadcastSSE({ type: 'STATUS_UPDATED', message: `Deleted ${initialCount - db.students.length} student record(s).` });

  res.json({ success: true, message: `Successfully deleted ${initialCount - db.students.length} student record(s).` });
});

app.post('/api/students/clear-all', async (req, res) => {
  const db = await syncDB();
  
  for (const s of db.students) {
    if (s.driveFileId) await deletePhoto(s.driveFileId);
  }

  db.students = [];
  db.lastBatchTimestamp = null;
  await saveDB(db);

  broadcastSSE({ type: 'STATUS_UPDATED', message: 'All student data cleared!' });

  res.json({ success: true, message: 'All student data and photos cleared.' });
});

app.delete('/api/students/:id', async (req, res) => {
  const { id } = req.params;
  const db = await syncDB();
  const index = db.students.findIndex(s => s.id === id);

  if (index === -1) return res.status(404).json({ error: 'Record not found.' });

  const student = db.students[index];
  if (student.driveFileId) await deletePhoto(student.driveFileId);

  db.students.splice(index, 1);
  await saveDB(db);

  res.json({ success: true, message: 'Record deleted.' });
});

app.get('/api/export/excel', async (req, res) => {
  const { status } = req.query;
  const db = await syncDB();
  let list = db.students || [];

  if (status && ['Pending', 'Generated'].includes(status)) {
    list = list.filter(s => s.status === status);
  }

  const excelRows = list.map((s, index) => ({
    'S.No': index + 1,
    'Student Name': s.studentName,
    'Class': s.className,
    'Date of Birth (DD.MM.YYYY)': s.dob,
    'Father Name': s.fatherName,
    'Contact 1 (Primary)': s.contact1,
    'Contact 2 (Optional)': s.contact2 || '',
    'Address': s.address,
    'Photo File Name': s.photoFilename,
    'Status': s.status,
    'Submission Time': new Date(s.submittedAt).toLocaleString(),
    'Google Drive Photo Link': s.photoPath
  }));

  const worksheet = XLSX.utils.json_to_sheet(excelRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Students');

  worksheet['!cols'] = [
    { wch: 6 },  { wch: 25 }, { wch: 12 }, { wch: 18 }, { wch: 25 },
    { wch: 18 }, { wch: 18 }, { wch: 35 }, { wch: 45 }, { wch: 14 },
    { wch: 22 }, { wch: 55 }
  ];

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const filename = `Student_Data_${status || 'All'}_${Date.now()}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(buffer);
});

app.get('/api/export/csv', async (req, res) => {
  const { status } = req.query;
  const db = await syncDB();
  let list = db.students || [];

  if (status && ['Pending', 'Generated'].includes(status)) {
    list = list.filter(s => s.status === status);
  }

  const headers = [
    'S.No', 'Student Name', 'Class', 'Date of Birth', 'Father Name',
    'Contact 1 (Primary)', 'Contact 2 (Optional)', 'Address', 'Photo File Name', 'Status',
    'Submission Time', 'Google Drive Photo Link'
  ];

  const escapeCSV = (val) => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const rows = list.map((s, idx) => [
    idx + 1, s.studentName, s.className, s.dob, s.fatherName,
    s.contact1, s.contact2 || '', s.address, s.photoFilename, s.status,
    new Date(s.submittedAt).toLocaleString(), s.photoPath
  ].map(escapeCSV).join(','));

  const csvContent = [headers.map(escapeCSV).join(','), ...rows].join('\n');
  const filename = `Student_Data_${status || 'All'}_${Date.now()}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(csvContent);
});

app.get('/api/export/photos-zip', async (req, res) => {
  try {
    const db = await syncDB();
    const students = db.students || [];

    if (!students.length) {
      return res.status(400).json({ error: 'No student photos available.' });
    }

    const zip = new JSZip();
    let fileCount = 0;

    for (const s of students) {
      if (APPS_SCRIPT_URL && s.driveFileId) {
        try {
          const downloadUrl = `${APPS_SCRIPT_URL}?action=get_file&fileId=${s.driveFileId}`;
          const base64Data = await makeRequest(downloadUrl, 'GET');
          
          if (base64Data && typeof base64Data === 'string' && !base64Data.startsWith('{')) {
            const photoBuffer = Buffer.from(base64Data, 'base64');
            zip.file(s.photoFilename, photoBuffer);
            fileCount++;
          }
        } catch (err) {
          console.error(`Error downloading photo from drive for ${s.studentName}:`, err.message);
        }
      } else {
        const photoFile = path.join(uploadsDir, s.photoFilename);
        if (fs.existsSync(photoFile)) {
          zip.file(s.photoFilename, fs.readFileSync(photoFile));
          fileCount++;
        }
      }
    }

    if (fileCount === 0) {
      return res.status(400).json({ error: 'No photo files found.' });
    }

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    const filename = `Student_Photos_${Date.now()}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(zipBuffer);
  } catch (err) {
    return res.status(500).json({ error: 'Error generating ZIP: ' + err.message });
  }
});

// Page Fallbacks
app.get('/admin*', (req, res) => {
  const adminPath = path.join(__dirname, 'public', 'admin.html');
  if (fs.existsSync(adminPath)) res.sendFile(adminPath);
  else res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`🚀 ID Card Data Collector Server running on port ${PORT}!`);
  if (APPS_SCRIPT_URL) {
    console.log(`☁️ Google Apps Script Integration Active!`);
  } else {
    console.log(`💻 running in Local Storage mode.`);
  }
  console.log(`===================================================`);
});
