const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const XLSX = require('xlsx');
const JSZip = require('jszip');

const app = express();
const PORT = process.env.PORT || 3000;

// Directories
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads', 'photos');
const dbFilePath = path.join(dataDir, 'students.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

if (!fs.existsSync(dbFilePath)) {
  fs.writeFileSync(dbFilePath, JSON.stringify({ students: [], lastBatchTimestamp: null }, null, 2));
}

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(dbFilePath, 'utf8'));
  } catch (err) {
    return { students: [], lastBatchTimestamp: null };
  }
}

function writeDB(data) {
  fs.writeFileSync(dbFilePath, JSON.stringify(data, null, 2), 'utf8');
}

// Multer Storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const sanitizeName = (req.body.studentName || 'student').replace(/[^a-zA-Z0-9_-]/g, '_');
    const sanitizeClass = (req.body.className || 'class').replace(/[^a-zA-Z0-9_-]/g, '_');
    cb(null, `photo_${sanitizeClass}_${sanitizeName}_${Date.now()}${ext}`);
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

// --- API ENDPOINTS ---

// 1. Get Students & Summary Stats
app.get('/api/students', (req, res) => {
  const db = readDB();
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

// 2. Submit Student Registration Form
app.post('/api/students/submit', upload.single('photo'), (req, res) => {
  try {
    const { studentName, className, dob, fatherName, contact1, contact2, contact3, address } = req.body;

    if (!studentName || !className || !dob || !fatherName || !contact1 || !contact2 || !address || !req.file) {
      return res.status(400).json({ error: 'All 7 mandatory fields are required!' });
    }

    const db = readDB();
    const photoFilename = req.file.filename;
    const photoPath = `/uploads/photos/${photoFilename}`;
    const fullLocalPhotoPath = path.join(uploadsDir, photoFilename);

    const studentRecord = {
      id: `STU-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      studentName: studentName.trim(),
      className: className.trim(),
      dob: dob.trim(),
      fatherName: fatherName.trim(),
      contact1: contact1.trim(),
      contact2: contact2.trim(),
      contact3: contact3 ? contact3.trim() : '',
      address: address.trim(),
      photoFilename,
      photoPath,
      localFolderLocation: fullLocalPhotoPath,
      status: 'Pending',
      submittedAt: new Date().toISOString()
    };

    db.students.push(studentRecord);
    writeDB(db);

    const updatedPending = db.students.filter(s => s.status === 'Pending').length;
    const lastBatchTime = db.lastBatchTimestamp ? new Date(db.lastBatchTimestamp).getTime() : 0;
    const lateCount = db.students.filter(s => s.status === 'Pending' && new Date(s.submittedAt).getTime() > lastBatchTime).length;

    broadcastSSE({
      type: 'NEW_SUBMISSION',
      message: `New student registration: ${studentRecord.studentName} (${studentRecord.className})`,
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
    return res.status(500).json({ error: 'Server error processing submission: ' + err.message });
  }
});

// 3. Batch Status Update (e.g. mark as Generated)
app.post('/api/students/batch-status', (req, res) => {
  const { ids, status } = req.body;
  if (!Array.isArray(ids) || !ids.length || !['Pending', 'Generated'].includes(status)) {
    return res.status(400).json({ error: 'Invalid batch parameters.' });
  }

  const db = readDB();
  let updatedCount = 0;

  db.students = db.students.map(s => {
    if (ids.includes(s.id)) {
      updatedCount++;
      return { ...s, status };
    }
    return s;
  });

  if (status === 'Generated') db.lastBatchTimestamp = new Date().toISOString();

  writeDB(db);

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

// 4. Batch Delete Selected Students
app.post('/api/students/batch-delete', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'Please select at least one student to delete.' });
  }

  const db = readDB();
  const initialCount = db.students.length;

  db.students = db.students.filter(s => {
    if (ids.includes(s.id)) {
      // Remove photo file
      const photoFile = path.join(uploadsDir, s.photoFilename);
      if (fs.existsSync(photoFile)) {
        try { fs.unlinkSync(photoFile); } catch (e) {}
      }
      return false;
    }
    return true;
  });

  const deletedCount = initialCount - db.students.length;
  writeDB(db);

  broadcastSSE({ type: 'STATUS_UPDATED', message: `Deleted ${deletedCount} student record(s).` });

  res.json({ success: true, message: `Successfully deleted ${deletedCount} student record(s).` });
});

// 5. Clear ALL Data (Delete all prefilled demo data)
app.post('/api/students/clear-all', (req, res) => {
  const db = readDB();
  
  // Delete all photos from uploads directory
  if (fs.existsSync(uploadsDir)) {
    const files = fs.readdirSync(uploadsDir);
    for (const file of files) {
      try { fs.unlinkSync(path.join(uploadsDir, file)); } catch (e) {}
    }
  }

  db.students = [];
  db.lastBatchTimestamp = null;
  writeDB(db);

  broadcastSSE({ type: 'STATUS_UPDATED', message: 'All student data and photos cleared!' });

  res.json({ success: true, message: 'All prefilled student data and photos have been deleted.' });
});

// 6. Delete Single Record
app.delete('/api/students/:id', (req, res) => {
  const { id } = req.params;
  const db = readDB();
  const index = db.students.findIndex(s => s.id === id);

  if (index === -1) return res.status(404).json({ error: 'Record not found.' });

  const student = db.students[index];
  const photoFile = path.join(uploadsDir, student.photoFilename);
  if (fs.existsSync(photoFile)) {
    try { fs.unlinkSync(photoFile); } catch (e) {}
  }

  db.students.splice(index, 1);
  writeDB(db);

  res.json({ success: true, message: 'Record deleted.' });
});

// 7. Download Excel (.xlsx) Format
app.get('/api/export/excel', (req, res) => {
  const { status } = req.query;
  const db = readDB();
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
    'Contact 1': s.contact1,
    'Contact 2': s.contact2,
    'Contact 3': s.contact3 || '',
    'Address': s.address,
    'Status': s.status,
    'Submission Time': new Date(s.submittedAt).toLocaleString(),
    'Photo File Name': s.photoFilename,
    'Local Photo Path': s.localFolderLocation
  }));

  const worksheet = XLSX.utils.json_to_sheet(excelRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Students');

  worksheet['!cols'] = [
    { wch: 6 },  { wch: 25 }, { wch: 12 }, { wch: 18 }, { wch: 25 },
    { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 35 }, { wch: 14 },
    { wch: 22 }, { wch: 35 }, { wch: 55 }
  ];

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const filename = `Student_Data_${status || 'All'}_${Date.now()}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(buffer);
});

// 8. Download CSV (.csv) Format
app.get('/api/export/csv', (req, res) => {
  const { status } = req.query;
  const db = readDB();
  let list = db.students || [];

  if (status && ['Pending', 'Generated'].includes(status)) {
    list = list.filter(s => s.status === status);
  }

  const headers = [
    'S.No', 'Student Name', 'Class', 'Date of Birth', 'Father Name',
    'Contact 1', 'Contact 2', 'Contact 3', 'Address', 'Status',
    'Submission Time', 'Photo File Name', 'Local Photo Path'
  ];

  const escapeCSV = (val) => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const rows = list.map((s, idx) => [
    idx + 1, s.studentName, s.className, s.dob, s.fatherName,
    s.contact1, s.contact2, s.contact3 || '', s.address, s.status,
    new Date(s.submittedAt).toLocaleString(), s.photoFilename, s.localFolderLocation
  ].map(escapeCSV).join(','));

  const csvContent = [headers.map(escapeCSV).join(','), ...rows].join('\n');
  const filename = `Student_Data_${status || 'All'}_${Date.now()}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(csvContent);
});

// 9. Download All Student Photos as ZIP Archive (for Cloud Deployments)
app.get('/api/export/photos-zip', async (req, res) => {
  try {
    const db = readDB();
    const students = db.students || [];

    if (!students.length) {
      return res.status(400).json({ error: 'No student photos available to download.' });
    }

    const zip = new JSZip();
    let fileCount = 0;

    students.forEach(s => {
      const photoFile = path.join(uploadsDir, s.photoFilename);
      if (fs.existsSync(photoFile)) {
        const fileData = fs.readFileSync(photoFile);
        const cleanClass = (s.className || 'Class').replace(/[^a-zA-Z0-9_-]/g, '_');
        const cleanName = (s.studentName || 'Student').replace(/[^a-zA-Z0-9_-]/g, '_');
        const ext = path.extname(s.photoFilename) || '.jpg';
        const zipFilename = `${cleanClass}/${cleanName}_${s.id}${ext}`;
        zip.file(zipFilename, fileData);
        fileCount++;
      }
    });

    if (fileCount === 0) {
      return res.status(400).json({ error: 'No valid photo files found on server.' });
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

app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`🚀 ID Card Data Collector Server running!`);
  console.log(`📌 Public Student Form:  http://localhost:${PORT}/`);
  console.log(`📌 Admin Dashboard:       http://localhost:${PORT}/admin.html`);
  console.log(`📁 Local Photos Directory: ${uploadsDir}`);
  console.log(`===================================================`);
});
