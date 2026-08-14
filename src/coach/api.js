// @ts-nocheck
const WORKER_BASE_URL = import.meta.env.VITE_WORKER_BASE_URL;
const APP_SHARED_SECRET = import.meta.env.VITE_APP_SHARED_SECRET;

function authHeaders(extra){
  return Object.assign({'X-App-Secret': APP_SHARED_SECRET}, extra||{});
}

// `type` picks the model/token profile server-side (worker/src/anthropic.js) - never
// pass a raw model name here, the Worker won't accept one.
export async function callAnthropic(type, system, messages){
  const resp = await fetch(WORKER_BASE_URL+'/anthropic/messages', {
    method: 'POST',
    headers: authHeaders({'Content-Type':'application/json'}),
    body: JSON.stringify({type, system, messages}),
  });
  if(!resp.ok){
    const err = new Error('HTTP '+resp.status);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

export function stravaAuthorizeUrl(){
  return WORKER_BASE_URL+'/strava/authorize';
}

// Cheap, no-Claude-involved activity list for the deferred pre-match step.
export async function stravaListActivities(afterUnix, beforeUnix){
  const params = new URLSearchParams();
  if(afterUnix) params.set('after', afterUnix);
  if(beforeUnix) params.set('before', beforeUnix);
  const resp = await fetch(WORKER_BASE_URL+'/strava/activities?'+params.toString(), {
    headers: authHeaders(),
  });
  if(!resp.ok){
    const err = new Error('HTTP '+resp.status);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

export async function stravaGetStreams(activityId){
  const resp = await fetch(WORKER_BASE_URL+'/strava/activity/'+activityId+'/streams', {
    headers: authHeaders(),
  });
  if(!resp.ok){
    const err = new Error('HTTP '+resp.status);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

export async function stravaGetLaps(activityId){
  const resp = await fetch(WORKER_BASE_URL+'/strava/activity/'+activityId+'/laps', {
    headers: authHeaders(),
  });
  if(!resp.ok){
    const err = new Error('HTTP '+resp.status);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}
