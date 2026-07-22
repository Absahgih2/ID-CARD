const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const XLSX = require('xlsx');
const JSZip = require('jszip');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'printdigi001@gmail.com';
const DRIVE_FOLDER_ID = '17P5FHKTADmXHrMC9KeoRCcbCjXh1xbYr';

// Directories
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads', 'photos');
const dbFilePath = path.join(dataDir, 'students.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// --- GOOGLE DRIVE AUTHENTICATION ---
let driveClient = null;

function getDriveClient() {
  if (driveClient) return driveClient;
  
  try {
    let authConfig;
    if (process.env.GOOGLE_CREDS) {
      authConfig = JSON.parse(process.env.GOOGLE_CREDS);
    } else {
      const keyPath = path.join(__dirname, 'google-key.json');
      if (fs.existsSync(keyPath)) {
        authConfig = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
      }
    }

    if (!authConfig) {
      console.warn("⚠️ No Google Drive API credentials configured!");
      return null;
    }

    const auth = new google.auth.JWT(
      authConfig.client_email,
      null,
      authConfig.private_key,
      ['https://www.googleapis.com/auth/drive']
    );

    driveClient = google.drive({ version: 'v3', auth });
    return driveClient;
  } catch (err) {
    console.error("❌ Error initializing Google Drive client:", err.message);
    return null;
  }
}

// --- GOOGLE DRIVE DATA PERSISTENCE HELPERS ---
let dbFileId = null;

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

async function syncDBFromDrive() {
  const drive = getDriveClient();
  if (!drive) return readLocalDB();

  try {
    const res = await drive.files.list({
      q: `name='students.json' and '${DRIVE_FOLDER_ID}' in parents and trashed=false`,
      fields: 'files(id, name)',
      spaces: 'drive'
    });

    const files = res.data.files;
    if (files && files.length > 0) {
      dbFileId = files[0].id;
      const fileContentRes = await drive.files.get({
        fileId: dbFileId,
        alt: 'media'
      });
      
      const dbData = typeof fileContentRes.data === 'string' 
        ? JSON.parse(fileContentRes.data) 
        : fileContentRes.data;

      writeLocalDB(dbData);
      return dbData;
    } else {
      const initialData = { students: [], lastBatchTimestamp: null };
      const media = {
        mimeType: 'application/json',
        body: JSON.stringify(initialData, null, 2)
      };
      const createRes = await drive.files.create({
        requestBody: {
          name: 'students.json',
          parents: [DRIVE_FOLDER_ID]
        },
        media: media,
        fields: 'id'
      });
      dbFileId = createRes.data.id;
      writeLocalDB(initialData);
      return initialData;
    }
  } catch (err) {
    console.error("❌ Error syncing database from Google Drive:", err.message);
    return readLocalDB();
  }
}

async function uploadDBToDrive(dbData) {
  writeLocalDB(dbData);

  const drive = getDriveClient();
  if (!drive) return;

  try {
    if (!dbFileId) {
      const res = await drive.files.list({
        q: `name='students.json' and '${DRIVE_FOLDER_ID}' in parents and trashed=false`,
        fields: 'files(id)'
      });
      if (res.data.files && res.data.files.length > 0) {
        dbFileId = res.data.files[0].id;
      }
    }

    const media = {
      mimeType: 'application/json',
      body: JSON.stringify(dbData, null, 2)
    };

    if (dbFileId) {
      await drive.files.update({
        fileId: dbFileId,
        media: media
      });
    } else {
      const createRes = await drive.files.create({
        requestBody: {
          name: 'students.json',
          parents: [DRIVE_FOLDER_ID]
        },
        media: media,
        fields: 'id'
      });
      dbFileId = createRes.data.id;
    }
    console.log("☁️ Database students.json saved on Google Drive.");
  } catch (err) {
    console.error("❌ Error uploading database to Google Drive:", err.message);
  }
}

async function uploadPhotoToDrive(localPath, filename) {
  const drive = getDriveClient();
  if (!drive) return null;

  try {
    const media = {
      mimeType: 'image/jpeg',
      body: fs.createReadStream(localPath)
    };

    const res = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [DRIVE_FOLDER_ID]
      },
      media: media,
      fields: 'id, webViewLink, webContentLink'
    });

    console.log(`☁️ Uploaded photo to Drive: ${filename} (ID: ${res.data.id})`);
    
    // Delete local temp file
    try { fs.unlinkSync(localPath); } catch (e) {}

    return {
      id: res.data.id,
      webViewLink: res.data.webViewLink,
      webContentLink: res.data.webContentLink
    };
  } catch (err) {
    console.error("❌ Error uploading photo to Google Drive:", err.message);
    return null;
  }
}

async function deleteFileFromDrive(fileId) {
  const drive = getDriveClient();
  if (!drive || !fileId) return;
  try {
    await drive.files.delete({ fileId: fileId });
    console.log(`☁️ Deleted file from Google Drive (ID: ${fileId})`);
  } catch (e) {
    console.error(`❌ Error deleting file from Google Drive:`, e.message);
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
  const drive = getDriveClient();
  if (!drive) {
    return res.status(500).json({ 
      success: false, 
      error: 'Google Drive client not initialized. Ensure GOOGLE_CREDS or google-key.json is configured.' 
    });
  }

  try {
    // 1. Test connection to the specific folder
    const folderTest = await drive.files.get({
      fileId: DRIVE_FOLDER_ID,
      fields: 'id, name, permissions'
    });

    res.json({
      success: true,
      message: 'Successfully connected to Google Drive!',
      folderName: folderTest.data.name,
      folderId: folderTest.data.id
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: `Failed to access folder: ${err.message}. Make sure folder ID is correct and shared with the service account email.`
    });
  }
});

// --- DAILY 4:00 PM EMAIL SUMMARY ENGINE ---
async function sendDailySummaryEmail() {
  const db = await syncDBFromDrive();
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
  const db = await syncDBFromDrive();
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

    // Upload Photo to Google Drive
    const drivePhoto = await uploadPhotoToDrive(tempLocalPath, photoFilename);
    const driveFileId = drivePhoto ? drivePhoto.id : '';
    const photoPath = drivePhoto ? drivePhoto.webViewLink : `/uploads/photos/${photoFilename}`;

    const db = await syncDBFromDrive();

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
    await uploadDBToDrive(db);

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

  const db = await syncDBFromDrive();
  let updatedCount = 0;

  db.students = db.students.map(s => {
    if (ids.includes(s.id)) {
      updatedCount++;
      return { ...s, status };
    }
    return s;
  });

  if (status === 'Generated') db.lastBatchTimestamp = new Date().toISOString();

  await uploadDBToDrive(db);

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

  const db = await syncDBFromDrive();
  const initialCount = db.students.length;

  for (const s of db.students) {
    if (ids.includes(s.id)) {
      if (s.driveFileId) await deleteFileFromDrive(s.driveFileId);
    }
  }

  db.students = db.students.filter(s => !ids.includes(s.id));
  await uploadDBToDrive(db);

  broadcastSSE({ type: 'STATUS_UPDATED', message: `Deleted ${initialCount - db.students.length} student record(s).` });

  res.json({ success: true, message: `Successfully deleted ${initialCount - db.students.length} student record(s).` });
});

app.post('/api/students/clear-all', async (req, res) => {
  const db = await syncDBFromDrive();
  
  for (const s of db.students) {
    if (s.driveFileId) await deleteFileFromDrive(s.driveFileId);
  }

  db.students = [];
  db.lastBatchTimestamp = null;
  await uploadDBToDrive(db);

  broadcastSSE({ type: 'STATUS_UPDATED', message: 'All student data cleared!' });

  res.json({ success: true, message: 'All student data and photos cleared.' });
});

app.delete('/api/students/:id', async (req, res) => {
  const { id } = req.params;
  const db = await syncDBFromDrive();
  const index = db.students.findIndex(s => s.id === id);

  if (index === -1) return res.status(404).json({ error: 'Record not found.' });

  const student = db.students[index];
  if (student.driveFileId) await deleteFileFromDrive(student.driveFileId);

  db.students.splice(index, 1);
  await uploadDBToDrive(db);

  res.json({ success: true, message: 'Record deleted.' });
});

app.get('/api/export/excel', async (req, res) => {
  const { status } = req.query;
  const db = await syncDBFromDrive();
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
  const db = await syncDBFromDrive();
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
    const db = await syncDBFromDrive();
    const students = db.students || [];

    if (!students.length) {
      return res.status(400).json({ error: 'No student photos available.' });
    }

    const zip = new JSZip();
    const drive = getDriveClient();
    let fileCount = 0;

    for (const s of students) {
      if (drive && s.driveFileId) {
        try {
          const fileRes = await drive.files.get(
            { fileId: s.driveFileId, alt: 'media' },
            { responseType: 'arraybuffer' }
          );
          zip.file(s.photoFilename, Buffer.from(fileRes.data));
          fileCount++;
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
  console.log(`☁️ Google Drive Sync Active on Folder ID: ${DRIVE_FOLDER_ID}`);
  console.log(`===================================================`);
});
