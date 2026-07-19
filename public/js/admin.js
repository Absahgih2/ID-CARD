document.addEventListener('DOMContentLoaded', () => {
  const ADMIN_PASS = 'admin123';

  const loginModal = document.getElementById('loginModal');
  const loginForm = document.getElementById('loginForm');
  const adminPasswordInput = document.getElementById('adminPassword');
  const loginError = document.getElementById('loginError');
  const adminContent = document.getElementById('adminContent');
  const logoutBtn = document.getElementById('logoutBtn');

  if (sessionStorage.getItem('adminLoggedIn') === 'true') {
    unlockDashboard();
  }

  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (adminPasswordInput.value === ADMIN_PASS) {
      sessionStorage.setItem('adminLoggedIn', 'true');
      unlockDashboard();
    } else {
      loginError.style.display = 'block';
      loginError.textContent = '❌ Invalid Admin Password. (Default: admin123)';
    }
  });

  logoutBtn.addEventListener('click', () => {
    sessionStorage.removeItem('adminLoggedIn');
    window.location.reload();
  });

  function unlockDashboard() {
    loginModal.style.display = 'none';
    adminContent.style.display = 'block';
    initAdminLogic();
  }

  function initAdminLogic() {
    let allStudents = [];
    let currentFilter = 'All';
    let lastBatchTimestamp = null;
    let selectedStudentIds = new Set();

    const statTotal = document.getElementById('statTotal');
    const statGenerated = document.getElementById('statGenerated');
    const statPending = document.getElementById('statPending');
    const statLate = document.getElementById('statLate');
    const tabPendingCount = document.getElementById('tabPendingCount');
    const tabGeneratedCount = document.getElementById('tabGeneratedCount');
    const tableBody = document.getElementById('studentTableBody');
    const selectAllCheckbox = document.getElementById('selectAllCheckbox');
    const markBatchBtn = document.getElementById('markBatchBtn');
    const deleteBatchBtn = document.getElementById('deleteBatchBtn');
    const clearAllBtn = document.getElementById('clearAllBtn');
    const exportExcelBtn = document.getElementById('exportExcelBtn');
    const exportCsvBtn = document.getElementById('exportCsvBtn');
    const exportZipBtn = document.getElementById('exportZipBtn');
    const lateBanner = document.getElementById('lateBanner');
    const lateBannerText = document.getElementById('lateBannerText');
    const filterLateBtn = document.getElementById('filterLateBtn');
    const toastContainer = document.getElementById('toastContainer');

    function playNotificationSound() {
      try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.3);
      } catch (e) {}
    }

    function showToast(message, title = 'Notification') {
      const toast = document.createElement('div');
      toast.className = 'toast';
      toast.innerHTML = `
        <span style="font-size: 1.3rem;">🔔</span>
        <div>
          <strong style="display:block; font-size: 0.85rem; color: var(--accent-secondary);">${title}</strong>
          <span>${message}</span>
        </div>
      `;
      toastContainer.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
      }, 4500);
    }

    async function loadData() {
      try {
        const res = await fetch('/api/students');
        const data = await res.json();

        allStudents = data.students || [];
        lastBatchTimestamp = data.summary.lastBatchTimestamp;

        updateStats(data.summary);
        renderTable();
      } catch (err) {
        tableBody.innerHTML = `<tr><td colspan="10" style="color: var(--accent-danger); text-align: center;">Error loading records. Ensure server is running.</td></tr>`;
      }
    }

    function updateStats(summary) {
      statTotal.textContent = summary.total;
      statGenerated.textContent = summary.generated;
      statPending.textContent = summary.pending;
      statLate.textContent = summary.lateCount;

      tabPendingCount.textContent = summary.pending;
      tabGeneratedCount.textContent = summary.generated;

      if (summary.lateCount > 0) {
        lateBanner.style.display = 'flex';
        lateBannerText.textContent = `🚨 ${summary.lateCount} student(s) submitted form data after your last ID card generation batch!`;
      } else {
        lateBanner.style.display = 'none';
      }
    }

    function renderTable() {
      let filtered = allStudents;

      if (currentFilter === 'Pending') {
        filtered = allStudents.filter(s => s.status === 'Pending');
      } else if (currentFilter === 'Generated') {
        filtered = allStudents.filter(s => s.status === 'Generated');
      } else if (currentFilter === 'Late') {
        const lastBatchTime = lastBatchTimestamp ? new Date(lastBatchTimestamp).getTime() : 0;
        filtered = allStudents.filter(s => s.status === 'Pending' && new Date(s.submittedAt).getTime() > lastBatchTime);
      }

      if (!filtered.length) {
        tableBody.innerHTML = `
          <tr>
            <td colspan="10" style="text-align: center; color: var(--text-muted); padding: 2.5rem;">
              No student records found under filter "${currentFilter}".
            </td>
          </tr>
        `;
        selectAllCheckbox.checked = false;
        updateActionButtons();
        return;
      }

      const lastBatchTime = lastBatchTimestamp ? new Date(lastBatchTimestamp).getTime() : 0;

      tableBody.innerHTML = filtered.map(s => {
        const isLate = s.status === 'Pending' && new Date(s.submittedAt).getTime() > lastBatchTime;
        const isChecked = selectedStudentIds.has(s.id) ? 'checked' : '';
        
        let statusClass = 'pending';
        let statusLabel = 'Pending';

        if (s.status === 'Generated') {
          statusClass = 'generated';
          statusLabel = 'Generated';
        } else if (isLate) {
          statusClass = 'late';
          statusLabel = 'Late Update 🚨';
        }

        const contacts = [s.contact1, s.contact2, s.contact3].filter(Boolean).join(' / ');

        return `
          <tr>
            <td><input type="checkbox" class="row-checkbox" data-id="${s.id}" ${isChecked}></td>
            <td><img src="${s.photoPath}" class="thumb-img" alt="Photo" onclick="window.open('${s.photoPath}', '_blank')"></td>
            <td>
              <strong style="color: #fff;">${escapeHtml(s.studentName || s.fullName)}</strong>
              <div style="font-size: 0.75rem; color: var(--text-muted);">Father: ${escapeHtml(s.fatherName || '-')}</div>
            </td>
            <td><span style="font-weight: 700; color: #38bdf8;">${escapeHtml(s.className || s.department || '-')}</span></td>
            <td><code>${escapeHtml(s.dob || '-')}</code></td>
            <td>
              <div style="font-size: 0.8rem;">
                <div>📞 ${escapeHtml(contacts || 'N/A')}</div>
                <div style="color: var(--text-muted); font-size: 0.75rem;">🏠 ${escapeHtml(s.address || '-')}</div>
              </div>
            </td>
            <td><span class="status-badge ${statusClass}">${statusLabel}</span></td>
            <td style="font-size: 0.8rem; color: var(--text-muted);">${new Date(s.submittedAt).toLocaleString()}</td>
            <td><code style="font-size: 0.75rem; color: #38bdf8;">${escapeHtml(s.photoFilename)}</code></td>
            <td>
              <button class="btn" onclick="deleteStudent('${s.id}')" style="background: rgba(239, 68, 68, 0.2); color: #f87171; padding: 0.3rem 0.6rem; font-size: 0.75rem;">
                🗑️
              </button>
            </td>
          </tr>
        `;
      }).join('');

      document.querySelectorAll('.row-checkbox').forEach(chk => {
        chk.addEventListener('change', (e) => {
          const id = e.target.getAttribute('data-id');
          if (e.target.checked) selectedStudentIds.add(id);
          else selectedStudentIds.delete(id);
          updateActionButtons();
        });
      });

      updateActionButtons();
    }

    function updateActionButtons() {
      if (selectedStudentIds.size > 0) {
        markBatchBtn.disabled = false;
        markBatchBtn.innerHTML = `<span>✅</span> Mark ${selectedStudentIds.size} Selected as Generated`;

        deleteBatchBtn.disabled = false;
        deleteBatchBtn.innerHTML = `<span>🗑️</span> Delete ${selectedStudentIds.size} Selected`;
      } else {
        markBatchBtn.disabled = true;
        markBatchBtn.innerHTML = `<span>✅</span> Mark Selected as Generated`;

        deleteBatchBtn.disabled = true;
        deleteBatchBtn.innerHTML = `<span>🗑️</span> Delete Selected`;
      }
    }

    // Select All Checkbox Handler
    selectAllCheckbox.addEventListener('change', (e) => {
      let filtered = allStudents;
      if (currentFilter === 'Pending') filtered = allStudents.filter(s => s.status === 'Pending');
      if (currentFilter === 'Generated') filtered = allStudents.filter(s => s.status === 'Generated');

      if (e.target.checked) filtered.forEach(s => selectedStudentIds.add(s.id));
      else filtered.forEach(s => selectedStudentIds.delete(s.id));
      renderTable();
    });

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.getAttribute('data-filter');
        renderTable();
      });
    });

    filterLateBtn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      currentFilter = 'Late';
      renderTable();
    });

    // Mark Batch as Generated
    markBatchBtn.addEventListener('click', async () => {
      if (!selectedStudentIds.size) return;
      const ids = Array.from(selectedStudentIds);
      try {
        const res = await fetch('/api/students/batch-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, status: 'Generated' })
        });
        const result = await res.json();
        if (res.ok) {
          showToast(result.message, 'Batch Updated');
          selectedStudentIds.clear();
          selectAllCheckbox.checked = false;
          loadData();
        }
      } catch (err) {
        alert('Failed to update batch status.');
      }
    });

    // Delete Selected Students
    deleteBatchBtn.addEventListener('click', async () => {
      if (!selectedStudentIds.size) return;
      if (!confirm(`Are you sure you want to delete ${selectedStudentIds.size} selected student record(s) and their photos?`)) return;

      const ids = Array.from(selectedStudentIds);
      try {
        const res = await fetch('/api/students/batch-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids })
        });
        const result = await res.json();
        if (res.ok) {
          showToast(result.message, 'Records Deleted');
          selectedStudentIds.clear();
          selectAllCheckbox.checked = false;
          loadData();
        }
      } catch (err) {
        alert('Failed to delete selected records.');
      }
    });

    // Clear ALL Data (Delete prefilled test data)
    clearAllBtn.addEventListener('click', async () => {
      if (!confirm('⚠️ WARNING: This will permanently delete ALL student entries and photos! Are you sure you want to clear prefilled test data?')) return;

      try {
        const res = await fetch('/api/students/clear-all', { method: 'POST' });
        const result = await res.json();
        if (res.ok) {
          showToast(result.message, 'All Data Cleared');
          selectedStudentIds.clear();
          selectAllCheckbox.checked = false;
          loadData();
        }
      } catch (err) {
        alert('Failed to clear data.');
      }
    });

    exportExcelBtn.addEventListener('click', () => {
      window.location.href = `/api/export/excel?status=${currentFilter === 'Late' ? 'Pending' : currentFilter}`;
    });

    exportCsvBtn.addEventListener('click', () => {
      window.location.href = `/api/export/csv?status=${currentFilter === 'Late' ? 'Pending' : currentFilter}`;
    });

    exportZipBtn.addEventListener('click', () => {
      window.location.href = '/api/export/photos-zip';
    });

    window.deleteStudent = async (id) => {
      if (!confirm('Are you sure you want to delete this student record?')) return;
      try {
        const res = await fetch(`/api/students/${id}`, { method: 'DELETE' });
        if (res.ok) {
          selectedStudentIds.delete(id);
          loadData();
        }
      } catch (err) {
        alert('Error deleting student.');
      }
    };

    function connectSSE() {
      const eventSource = new EventSource('/api/notifications/stream');
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'NEW_SUBMISSION') {
            playNotificationSound();
            showToast(data.message, 'New Student Registration 🚨');
            loadData();
          } else if (data.type === 'STATUS_UPDATED') {
            loadData();
          }
        } catch (e) {}
      };
      eventSource.onerror = () => {
        eventSource.close();
        setTimeout(connectSSE, 5000);
      };
    }

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m]);
    }

    loadData();
    connectSSE();
  }
});
