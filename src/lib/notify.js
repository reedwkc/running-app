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
