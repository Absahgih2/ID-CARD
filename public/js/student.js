document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('studentForm');
  const dropZone = document.getElementById('dropZone');
  const photoInput = document.getElementById('photo');
  const photoPreview = document.getElementById('photoPreview');
  const dropText = document.getElementById('dropText');
  const alertBox = document.getElementById('alertBox');
  const submitBtn = document.getElementById('submitBtn');
  const dobInput = document.getElementById('dob');

  // Format DOB input automatically as DD.MM.YYYY
  dobInput.addEventListener('input', (e) => {
    let val = e.target.value.replace(/\D/g, '');
    if (val.length > 8) val = val.slice(0, 8);

    let formatted = '';
    if (val.length > 0) formatted += val.substring(0, 2);
    if (val.length >= 3) formatted += '.' + val.substring(2, 4);
    if (val.length >= 5) formatted += '.' + val.substring(4, 8);

    e.target.value = formatted;
  });

  // Convert text input values to uppercase as user types
  const uppercaseInputs = ['studentName', 'fatherName', 'address', 'contact1', 'contact2', 'contact3'];
  uppercaseInputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', () => {
        const start = el.selectionStart;
        const end = el.selectionEnd;
        el.value = el.value.toUpperCase();
        el.setSelectionRange(start, end);
        el.style.borderColor = 'var(--border-color)';
        const errEl = document.getElementById(`err-${id}`) || document.getElementById('err-contact');
        if (errEl) errEl.style.display = 'none';
      });
    }
  });

  // Dropzone Handlers
  dropZone.addEventListener('click', () => photoInput.click());

  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      photoInput.files = files;
      handleFile(files[0]);
    }
  });

  photoInput.addEventListener('change', () => {
    if (photoInput.files.length > 0) {
      handleFile(photoInput.files[0]);
    }
  });

  function handleFile(file) {
    if (!file.type.startsWith('image/')) {
      showAlert('PLEASE SELECT A VALID IMAGE FILE (JPG, PNG, WEBP).', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      photoPreview.src = e.target.result;
      photoPreview.style.display = 'inline-block';
      dropText.style.display = 'none';
      document.getElementById('err-photo').style.display = 'none';
    };
    reader.readAsDataURL(file);
  }

  // Handle Form Submission with STRICT VALIDATION & UPPERCASE ENFORCEMENT
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    let isValid = true;
    const missingFields = [];

    // Reset error styles
    uppercaseInputs.concat(['className', 'dob']).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.borderColor = 'var(--border-color)';
    });
    document.querySelectorAll('.error-msg').forEach(el => el.style.display = 'none');

    // 1. Student Name
    const studentName = document.getElementById('studentName');
    if (!studentName.value.trim()) {
      isValid = false;
      studentName.style.borderColor = '#ef4444';
      document.getElementById('err-studentName').style.display = 'block';
      missingFields.push('1. STUDENT NAME');
    }

    // 2. Class
    const className = document.getElementById('className');
    if (!className.value.trim()) {
      isValid = false;
      className.style.borderColor = '#ef4444';
      document.getElementById('err-className').style.display = 'block';
      missingFields.push('2. CLASS');
    }

    // 3. Date of Birth (DD.MM.YYYY)
    const dob = document.getElementById('dob');
    const dobRegex = /^\d{2}\.\d{2}\.\d{4}$/;
    if (!dob.value.trim() || !dobRegex.test(dob.value.trim())) {
      isValid = false;
      dob.style.borderColor = '#ef4444';
      document.getElementById('err-dob').style.display = 'block';
      missingFields.push('3. DATE OF BIRTH (MUST BE IN DD.MM.YYYY FORMAT)');
    }

    // 4. Father Name
    const fatherName = document.getElementById('fatherName');
    if (!fatherName.value.trim()) {
      isValid = false;
      fatherName.style.borderColor = '#ef4444';
      document.getElementById('err-fatherName').style.display = 'block';
      missingFields.push('4. FATHER NAME');
    }

    // 5. Contact Numbers
    const contact1 = document.getElementById('contact1');
    const contact2 = document.getElementById('contact2');
    if (!contact1.value.trim() || !contact2.value.trim()) {
      isValid = false;
      if (!contact1.value.trim()) contact1.style.borderColor = '#ef4444';
      if (!contact2.value.trim()) contact2.style.borderColor = '#ef4444';
      document.getElementById('err-contact').style.display = 'block';
      missingFields.push('5. AT LEAST 2 MOBILE CONTACT NUMBERS');
    }

    // 6. Address
    const address = document.getElementById('address');
    if (!address.value.trim()) {
      isValid = false;
      address.style.borderColor = '#ef4444';
      document.getElementById('err-address').style.display = 'block';
      missingFields.push('6. FULL RESIDENTIAL ADDRESS');
    }

    // 7. Passport Photo
    if (!photoInput.files.length) {
      isValid = false;
      document.getElementById('err-photo').style.display = 'block';
      missingFields.push('7. STUDENT PASSPORT PHOTO');
    }

    if (!isValid) {
      showAlert(`❌ FORM SUBMISSION BLOCKED! PLEASE COMPLETE ALL MANDATORY FIELDS:\n• ${missingFields.join('\n• ')}`, 'error');
      return;
    }

    // Ensure all values are UPPERCASE in FormData
    studentName.value = studentName.value.trim().toUpperCase();
    fatherName.value = fatherName.value.trim().toUpperCase();
    address.value = address.value.trim().toUpperCase();

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>SUBMITTING DATA & PHOTO...</span>';

    const formData = new FormData(form);

    try {
      const response = await fetch('/api/students/submit', {
        method: 'POST',
        body: formData
      });

      const result = await response.json();

      if (response.ok && result.success) {
        showAlert(`🎉 ${result.message.toUpperCase()}`, 'success');
        form.reset();
        photoPreview.style.display = 'none';
        dropText.style.display = 'block';
      } else {
        showAlert(`❌ ${(result.error || 'Submission failed.').toUpperCase()}`, 'error');
      }
    } catch (err) {
      showAlert('❌ SERVER NETWORK ERROR. PLEASE ENSURE THE BACKEND IS RUNNING.', 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>SUBMIT REGISTRATION DETAILS</span> <span>➔</span>';
    }
  });

  function showAlert(msg, type) {
    alertBox.style.display = 'block';
    alertBox.innerText = msg;
    if (type === 'success') {
      alertBox.style.background = 'rgba(16, 185, 129, 0.2)';
      alertBox.style.border = '1px solid rgba(16, 185, 129, 0.5)';
      alertBox.style.color = '#34d399';
    } else {
      alertBox.style.background = 'rgba(239, 68, 68, 0.2)';
      alertBox.style.border = '1px solid rgba(239, 68, 68, 0.5)';
      alertBox.style.color = '#f87171';
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});
