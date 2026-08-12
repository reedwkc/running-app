// Ambient types for this app's two big untyped surfaces: the Firebase-backed
// window.storage client (lib/storage.js), and the many window.fnName = fnName
// attachments each UI module does so inline onclick="fnName(...)" handlers can
// find them. The index signature covers those attachments generically rather
// than declaring every one by hand - they're plumbing, not the data this
// milestone is about typing.
interface Window {
  storage: {
    get(key: string, shared?: boolean): Promise<{ value: string } | null>;
    set(key: string, value: any, shared?: boolean): Promise<void>;
    delete(key: string, shared?: boolean): Promise<void>;
    list(prefix?: string, shared?: boolean): Promise<{ keys: string[] } | null>;
  };
  [key: string]: any;
}
