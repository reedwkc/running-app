export function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

export async function batchMap(items, batchSize, fn){
  let results = [];
  for(let i=0; i<items.length; i+=batchSize){
    const batch = items.slice(i, i+batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results = results.concat(batchResults);
  }
  return results;
}
