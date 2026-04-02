// fb-autofill.js — FIRST-FIN Facebook Marketplace Form Filler
// Injected into facebook.com/marketplace/create/vehicle by background.js
// Fills the vehicle listing form using data from the platform.
'use strict';

// ── React input helper ───────────────────────────────────────────────────
// Facebook uses React — setting .value directly doesn't trigger state updates.
// We use the native setter + dispatch an input event to make React see the change.
const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;

function setReactValue(el, value) {
  if (el.tagName === 'TEXTAREA') {
    nativeTextareaSetter.call(el, value);
  } else {
    nativeInputSetter.call(el, value);
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// ── DOM helpers ──────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Find an input/textarea by its aria-label (case-insensitive partial match)
function findByLabel(labelText) {
  const inputs = document.querySelectorAll('input, textarea');
  for (const inp of inputs) {
    const label = inp.getAttribute('aria-label') || '';
    if (label.toLowerCase().includes(labelText.toLowerCase())) return inp;
  }
  // Fallback: find by placeholder
  for (const inp of inputs) {
    const ph = inp.getAttribute('placeholder') || '';
    if (ph.toLowerCase().includes(labelText.toLowerCase())) return inp;
  }
  return null;
}

// Find a label element containing text, then find the associated input nearby
function findInputNearLabel(labelText) {
  const spans = document.querySelectorAll('span, label');
  for (const span of spans) {
    if (span.textContent.trim().toLowerCase().includes(labelText.toLowerCase())) {
      // Look for a sibling or nearby input
      const parent = span.closest('[role="group"]') || span.closest('div');
      if (parent) {
        const input = parent.querySelector('input, textarea');
        if (input) return input;
      }
    }
  }
  return null;
}

// Click a dropdown (combobox/listbox) and select an option by text
async function selectDropdown(labelText, optionText, retries = 3) {
  if (!optionText || optionText === '—') return false;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // Find the dropdown trigger — look for aria-label on a combobox or nearby label
      let trigger = document.querySelector(`[aria-label*="${labelText}" i][role="combobox"]`);

      if (!trigger) {
        // Try finding by label text in the DOM
        const labels = document.querySelectorAll('span, label');
        for (const lbl of labels) {
          if (lbl.textContent.trim().toLowerCase() === labelText.toLowerCase()) {
            const container = lbl.closest('[role="group"]') || lbl.parentElement?.parentElement;
            if (container) {
              trigger = container.querySelector('[role="combobox"]') || container.querySelector('input[type="text"]');
              if (trigger) break;
            }
          }
        }
      }

      if (!trigger) {
        console.log(`[FIRST-FIN] Dropdown "${labelText}" not found (attempt ${attempt + 1})`);
        await sleep(1000);
        continue;
      }

      // Click to open
      trigger.click();
      trigger.focus();
      await sleep(500);

      // If it's an input (searchable dropdown), type the value
      if (trigger.tagName === 'INPUT') {
        setReactValue(trigger, optionText);
        await sleep(800);
      }

      // Find and click the matching option
      const options = document.querySelectorAll('[role="option"], [role="listbox"] div[role="option"]');
      let found = false;
      for (const opt of options) {
        const text = opt.textContent.trim();
        if (text.toLowerCase() === optionText.toLowerCase() || text.toLowerCase().includes(optionText.toLowerCase())) {
          opt.click();
          found = true;
          break;
        }
      }

      if (!found) {
        // Try clicking any visible option list items
        const listItems = document.querySelectorAll('[role="listbox"] > div, ul[role="listbox"] li');
        for (const li of listItems) {
          if (li.textContent.trim().toLowerCase().includes(optionText.toLowerCase())) {
            li.click();
            found = true;
            break;
          }
        }
      }

      if (found) {
        console.log(`[FIRST-FIN] Selected "${optionText}" for "${labelText}"`);
        await sleep(300);
        return true;
      }

      // Close dropdown if option wasn't found
      document.body.click();
      await sleep(300);

    } catch (e) {
      console.warn(`[FIRST-FIN] Error selecting "${labelText}":`, e);
    }
    await sleep(500);
  }

  console.warn(`[FIRST-FIN] Could not select "${optionText}" for "${labelText}"`);
  return false;
}

// Fill a text input found by label
async function fillInput(labelText, value) {
  if (!value) return false;
  const input = findByLabel(labelText) || findInputNearLabel(labelText);
  if (!input) {
    console.warn(`[FIRST-FIN] Input "${labelText}" not found`);
    return false;
  }
  input.focus();
  input.click();
  await sleep(200);
  setReactValue(input, String(value));
  await sleep(200);
  console.log(`[FIRST-FIN] Filled "${labelText}" = "${value}"`);
  return true;
}

// Fill the description textarea
async function fillDescription(text) {
  if (!text) return false;
  // Facebook's description field
  const textarea = document.querySelector('textarea[aria-label*="escription" i]')
    || document.querySelector('textarea[placeholder*="escription" i]')
    || findByLabel('description')
    || document.querySelector('textarea');
  if (!textarea) {
    console.warn('[FIRST-FIN] Description textarea not found');
    return false;
  }
  textarea.focus();
  textarea.click();
  await sleep(200);
  setReactValue(textarea, text);
  await sleep(200);
  console.log('[FIRST-FIN] Filled description');
  return true;
}

// ── Facebook color mapping ───────────────────────────────────────────────
// Facebook has a fixed set of color options. Map common colors to FB's list.
const FB_COLORS = {
  'black': 'Black', 'white': 'White', 'silver': 'Silver', 'grey': 'Gray', 'gray': 'Gray',
  'red': 'Red', 'blue': 'Blue', 'green': 'Green', 'gold': 'Gold', 'brown': 'Brown',
  'beige': 'Beige', 'orange': 'Orange', 'yellow': 'Yellow', 'purple': 'Purple',
  'tan': 'Beige', 'maroon': 'Red', 'burgundy': 'Red', 'navy': 'Blue',
  'charcoal': 'Gray', 'champagne': 'Gold', 'pearl': 'White', 'bronze': 'Brown',
  'copper': 'Brown', 'cream': 'White', 'ivory': 'White', 'teal': 'Blue',
  'pink': 'Red', 'magnetic': 'Gray', 'ceramic': 'White', 'midnight': 'Blue',
  'glacier': 'White', 'obsidian': 'Black', 'wolf': 'Gray', 'mineral': 'Gray',
};

function mapToFbColor(color) {
  if (!color) return '';
  const c = color.toLowerCase().trim();
  // Direct match
  if (FB_COLORS[c]) return FB_COLORS[c];
  // Partial match
  for (const [key, val] of Object.entries(FB_COLORS)) {
    if (c.includes(key)) return val;
  }
  return '';
}

// ── Main form fill ───────────────────────────────────────────────────────
async function fillFacebookForm(vehicle) {
  console.log('[FIRST-FIN] Starting Facebook form fill:', vehicle);

  // Step 1: Vehicle type — usually pre-selected or first dropdown
  await selectDropdown('Vehicle type', 'Car/Truck');
  await sleep(400);

  // Step 2: Year
  if (vehicle.year) {
    await selectDropdown('Year', String(vehicle.year));
    await sleep(400);
  }

  // Step 3: Make
  if (vehicle.make) {
    await selectDropdown('Make', vehicle.make);
    await sleep(400);
  }

  // Step 4: Model — sometimes a text input, sometimes a dropdown
  if (vehicle.model) {
    const filled = await fillInput('Model', vehicle.model);
    if (!filled) await selectDropdown('Model', vehicle.model);
    await sleep(400);
  }

  // Step 5: Trim
  if (vehicle.trim) {
    await fillInput('Trim', vehicle.trim);
    await sleep(300);
  }

  // Step 6: Mileage
  if (vehicle.mileage) {
    await fillInput('Mileage', vehicle.mileage);
    await sleep(300);
  }

  // Step 7: Price
  if (vehicle.price) {
    await fillInput('Price', vehicle.price);
    await sleep(300);
  }

  // Step 8: Body style
  if (vehicle.body_style) {
    await selectDropdown('Body style', vehicle.body_style);
    await sleep(300);
  }

  // Step 9: Exterior color
  const extColor = mapToFbColor(vehicle.ext_color);
  if (extColor) {
    await selectDropdown('Exterior color', extColor);
    await sleep(300);
  }

  // Step 10: Interior color
  const intColor = mapToFbColor(vehicle.int_color);
  if (intColor) {
    await selectDropdown('Interior color', intColor);
    await sleep(300);
  }

  // Step 11: Condition
  await selectDropdown('Condition', 'Good');
  await sleep(300);

  // Step 12: Fuel type
  if (vehicle.fuel) {
    await selectDropdown('Fuel type', vehicle.fuel);
    await sleep(300);
  }

  // Step 13: Transmission
  if (vehicle.transmission) {
    await selectDropdown('Transmission', vehicle.transmission);
    await sleep(300);
  }

  // Step 14: Description
  if (vehicle.description) {
    await fillDescription(vehicle.description);
    await sleep(300);
  }

  // Try to check "Clean title" if available
  try {
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    for (const cb of checkboxes) {
      const label = cb.closest('label') || cb.parentElement;
      if (label && /clean title/i.test(label.textContent)) {
        if (!cb.checked) cb.click();
        break;
      }
    }
  } catch (e) { /* non-critical */ }

  console.log('[FIRST-FIN] Form fill complete!');
}

// ── Convert base64 data URL to File object ───────────────────────────────
function base64ToFile(dataUrl, filename, mimeType) {
  const arr = dataUrl.split(',');
  const mime = mimeType || arr[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
  const bstr = atob(arr[1]);
  const u8arr = new Uint8Array(bstr.length);
  for (let i = 0; i < bstr.length; i++) u8arr[i] = bstr.charCodeAt(i);
  return new File([u8arr], filename, { type: mime });
}

// ── Upload photos to Facebook's file input ───────────────────────────────
async function uploadPhotosToFacebook(photos) {
  if (!photos || !photos.length) {
    console.log('[FIRST-FIN] No photos to upload');
    return;
  }
  console.log(`[FIRST-FIN] Uploading ${photos.length} photos to Facebook...`);

  // Convert base64 data to File objects
  const files = photos.map((p, i) => base64ToFile(p.base64, p.name || `photo_${i+1}.jpg`, p.type));

  // Strategy 1: Find the file input and set files via DataTransfer
  const fileInputs = document.querySelectorAll('input[type="file"]');
  let targetInput = null;
  for (const inp of fileInputs) {
    if (inp.accept && /image/i.test(inp.accept)) { targetInput = inp; break; }
  }
  if (!targetInput && fileInputs.length > 0) targetInput = fileInputs[0];

  if (targetInput) {
    try {
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      targetInput.files = dt.files;
      targetInput.dispatchEvent(new Event('change', { bubbles: true }));
      console.log(`[FIRST-FIN] Set ${files.length} files on file input`);
      await sleep(1000);
      return;
    } catch (e) {
      console.warn('[FIRST-FIN] File input method failed:', e.message);
    }
  }

  // Strategy 2: Find the drop zone and simulate a drop event
  const dropZones = document.querySelectorAll('[role="button"], [class*="photo"], [class*="upload"], [class*="drop"]');
  let dropTarget = null;
  for (const el of dropZones) {
    const text = (el.textContent || '').toLowerCase();
    if (text.includes('photo') || text.includes('image') || text.includes('upload') || text.includes('drag')) {
      dropTarget = el;
      break;
    }
  }
  if (!dropTarget) {
    // Try the main form area
    dropTarget = document.querySelector('[role="main"]') || document.querySelector('form') || document.body;
  }

  if (dropTarget) {
    try {
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));

      // Simulate drag events
      const dragEnter = new DragEvent('dragenter', { bubbles: true, dataTransfer: dt });
      const dragOver = new DragEvent('dragover', { bubbles: true, dataTransfer: dt });
      const drop = new DragEvent('drop', { bubbles: true, dataTransfer: dt });

      dropTarget.dispatchEvent(dragEnter);
      await sleep(100);
      dropTarget.dispatchEvent(dragOver);
      await sleep(100);
      dropTarget.dispatchEvent(drop);
      console.log(`[FIRST-FIN] Dropped ${files.length} photos on target`);
      await sleep(1000);
      return;
    } catch (e) {
      console.warn('[FIRST-FIN] Drop method failed:', e.message);
    }
  }

  // Strategy 3: Click the "Add Photos" button to trigger file dialog, then intercept
  console.log('[FIRST-FIN] Could not auto-upload photos — user must add manually');
}

// ── Listen for vehicle data + photos from background.js ──────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'FB_FILL_FORM' && msg.vehicle) {
    (async () => {
      try {
        await fillFacebookForm(msg.vehicle);
        // Upload photos after form is filled
        if (msg.photos && msg.photos.length > 0) {
          await sleep(1000);
          await uploadPhotosToFacebook(msg.photos);
        }
        sendResponse({ ok: true });
      } catch (e) {
        console.error('[FIRST-FIN] Fill error:', e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // async response
  }
  return false;
});
