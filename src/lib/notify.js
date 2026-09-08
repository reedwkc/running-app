let container = null;
function ensureContainer(){
  if(container && document.body.contains(container)) return container;
  container = document.createElement('div');
  container.id = 'notify-container';
  document.body.appendChild(container);
  return container;
}

function show(message, kind, durationMs){
  const el = document.createElement('div');
  el.className = 'notify-toast notify-'+kind;
  el.textContent = message;
  ensureContainer().appendChild(el);
  requestAnimationFrame(()=> el.classList.add('show'));
  setTimeout(()=>{
    el.classList.remove('show');
    setTimeout(()=> el.remove(), 250);
  }, durationMs);
}

// For real failures the user needs to actually see - a read that looked corrupted, a
// save that was refused rather than risk overwriting good data with a truncated copy.
export function notifyError(message){
  console.error(message);
  show(message, 'error', 9000);
}

export function notifyInfo(message){
  show(message, 'info', 4000);
}

// Same toast, but with a real action button (e.g. "Undo") instead of plain text - built with
// real DOM elements (not innerHTML) so message text can never be misread as markup. actionFn
// runs once; the toast dismisses itself immediately after, whether or not the auto-dismiss
// timer has already fired.
export function notifyAction(message, actionLabel, actionFn, durationMs){
  const el = document.createElement('div');
  el.className = 'notify-toast notify-info notify-action';
  const msgSpan = document.createElement('span');
  msgSpan.textContent = message;
  el.appendChild(msgSpan);
  const btn = document.createElement('button');
  btn.className = 'notify-action-btn';
  btn.textContent = actionLabel;
  let dismissed = false;
  const dismiss = ()=>{
    if(dismissed) return;
    dismissed = true;
    el.classList.remove('show');
    setTimeout(()=> el.remove(), 250);
  };
  btn.onclick = ()=>{ dismiss(); actionFn(); };
  el.appendChild(btn);
  ensureContainer().appendChild(el);
  requestAnimationFrame(()=> el.classList.add('show'));
  setTimeout(dismiss, durationMs||6000);
}
