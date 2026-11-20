import type { GeoPoint, GeoRouteResult } from './geo.types';

export type JourneySample = GeoPoint & {
  accuracyMeters: number | null;
  capturedAt: string;
  receivedAt: string;
};
export const JOURNEY_SAMPLE_LIMIT = 20000;
const MAX_ACCURACY = 35;
const MAX_GAP_MS = 60000;
export function meters(a: GeoPoint, b: GeoPoint): number {
  const radians = Math.PI / 180;
  const lat = (b.latitude - a.latitude) * radians;
  const lng = (b.longitude - a.longitude) * radians;
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.sin(lng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
function mix(a: GeoPoint, b: GeoPoint, t: number): GeoPoint {
  return {latitude: a.latitude + (b.latitude - a.latitude) * t, longitude: a.longitude + (b.longitude - a.longitude) * t};
}
export function validPoint(p: GeoPoint): boolean {
  return Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180;
}

// Replay immutable samples in reception order. Never sort late fixes into an already counted segment.
export function buildJourney(samples: JourneySample[]) {
  const complete = samples.length <= JOURNEY_SAMPLE_LIMIT;
  const segments: GeoPoint[][] = [];
  const milestones: Array<GeoPoint & {distanceMeters: number}> = [];
  let anchor: JourneySample | null = null;
  let latest: JourneySample | null = null;
  let observedAt = -Infinity;
  let total = 0;
  let rejected = 0;
  let gaps = 0;
  for (const sample of samples.slice(0, JOURNEY_SAMPLE_LIMIT)) {
    const time = Date.parse(sample.capturedAt);
    const received = Date.parse(sample.receivedAt);
    if (!validPoint(sample) || !Number.isFinite(time) || !Number.isFinite(received) ||
        time <= observedAt || time > received + 5000 || received - time > MAX_GAP_MS ||
        sample.accuracyMeters === null || !Number.isFinite(sample.accuracyMeters) ||
        sample.accuracyMeters < 0 || sample.accuracyMeters > MAX_ACCURACY) {
      rejected++; continue;
    }
    observedAt = time;
    if (!anchor || time - Date.parse(anchor.capturedAt) > MAX_GAP_MS) {
      if (anchor) gaps++;
      segments.push([{latitude: sample.latitude, longitude: sample.longitude}]);
      anchor = sample; latest = sample; continue;
    }
    const distance = meters(anchor, sample);
    const seconds = (time - Date.parse(anchor.capturedAt)) / 1000;
    if (distance / seconds > 40) { rejected++; continue; }
    const noise = Math.max(5, ((anchor.accuracyMeters ?? MAX_ACCURACY) + sample.accuracyMeters) / 2);
    if (distance < noise) {
      // Refresh freshness at the accepted anchor without adding stationary jitter to travel.
      latest = {...anchor, capturedAt: sample.capturedAt, receivedAt: sample.receivedAt};
      continue;
    }
    const nextTotal = total + distance;
    for (let mark = (Math.floor(total / 200) + 1) * 200; mark <= nextTotal + 1e-7; mark += 200) {
      milestones.push({...mix(anchor, sample, Math.min(1, (mark - total) / distance)), distanceMeters: mark});
    }
    segments[segments.length - 1].push({latitude: sample.latitude, longitude: sample.longitude});
    total = nextTotal;
    anchor = sample; latest = sample;
  }
  return {
    segments, milestones: complete ? milestones : [],
    distanceMeters: complete ? total : null,
    complete, gaps, rejected, latest: complete ? latest : null,
  };
}

export function decodeRoute(encoded: string): GeoPoint[] {
  let i = 0, lat = 0, lng = 0;
  const points: GeoPoint[] = [];
  function delta() {
    let value = 0, shift = 0, byte = 0;
    do {
      if (i >= encoded.length || shift > 30) throw new Error('INVALID_ROUTE_GEOMETRY');
      byte = encoded.charCodeAt(i++) - 63;
      if (byte < 0 || byte > 63) throw new Error('INVALID_ROUTE_GEOMETRY');
      value |= (byte & 31) << shift; shift += 5;
    } while (byte >= 32);
    return value & 1 ? ~(value >> 1) : value >> 1;
  }
  while (i < encoded.length) {
    lat += delta(); lng += delta();
    const point = {latitude: lat / 1e5, longitude: lng / 1e5};
    if (!validPoint(point)) throw new Error('INVALID_ROUTE_POINT');
    points.push(point);
  }
  if (points.length < 2) throw new Error('EMPTY_ROUTE_GEOMETRY');
  return points;
}
export function projectRoute(path: GeoPoint[], current: GeoPoint, min = 0, max = Infinity) {
  let along = 0;
  let best = {distance: Infinity, progress: min};
  const k = 111320, cos = Math.cos(current.latitude * Math.PI / 180);
  for (let i = 1; i < path.length; i++) {
    const a = path[i-1], b = path[i];
    const length = meters(a,b);
    const ax = (a.longitude-current.longitude)*k*cos, ay = (a.latitude-current.latitude)*k;
    const dx = (b.longitude-a.longitude)*k*cos, dy = (b.latitude-a.latitude)*k;
    const raw = -(ax*dx+ay*dy)/(dx*dx+dy*dy || 1);
    const low = Math.max(0,(min-along)/(length || 1));
    const high = Math.min(1,(max-along)/(length || 1));
    if (low <= high) {
      const t = Math.max(low,Math.min(high,raw));
      const distance = Math.hypot(ax+t*dx,ay+t*dy);
      if (distance < best.distance - 0.01) best={distance,progress:along+t*length};
    }
    along += length;
  }
  return {...best,total:along};
}
function remainingPath(path: GeoPoint[], progress: number): GeoPoint[] {
  let along = 0;
  for (let i=1;i<path.length;i++) {
    const length=meters(path[i-1],path[i]);
    if (along+length >= progress) return [mix(path[i-1],path[i],length ? (progress-along)/length : 0),...path.slice(i)];
    along+=length;
  }
  return path.slice(-1);
}
type NavigationEntry = {
  route: GeoRouteResult | null; path: GeoPoint[]; revision: number;
  lastAttempt: number; lastSeen: number; sampleTime: number;
  deviations: number; progress: number; point: GeoPoint | null;
  pending?: Promise<void>; failed: boolean;
};
export class DriverJourneyNavigation {
  private readonly entries = new Map<string, NavigationEntry>();
  constructor(private readonly now: () => number = Date.now) {}
  async get(key: string, sample: JourneySample | null, destination: GeoPoint,
    calculate: (origin: GeoPoint, destination: GeoPoint) => Promise<GeoRouteResult>) {
    const now=this.now();
    const cacheKey=JSON.stringify([key,destination.latitude,destination.longitude]);
    let entry=this.entries.get(cacheKey);
    if (!entry) {
      for (const [id,value] of this.entries) if (!value.pending && now-value.lastSeen>1800000) this.entries.delete(id);
      if(this.entries.size>=1000) {
        const victim=[...this.entries].find(([,value])=>!value.pending);
        if(victim) this.entries.delete(victim[0]);
      }
      if(this.entries.size>=1000) return {route:null,remainingPath:[],revision:0,status:'UNAVAILABLE',distanceMeters:null,durationSeconds:null};
      entry={route:null,path:[],revision:0,lastAttempt:-Infinity,lastSeen:now,sampleTime:-Infinity,deviations:0,progress:0,point:null,failed:false};
      this.entries.set(cacheKey,entry);
    }
    entry.lastSeen=now;
    const time=sample ? Date.parse(sample.capturedAt) : NaN;
    const fresh=!!sample && Number.isFinite(time) && now-time<=30000 && time<=now+5000;
    if (fresh && time>entry.sampleTime && !entry.pending) {
      const projection=projectRoute(entry.path,sample);
      const offRoute=entry.path.length>1 && projection.distance>Math.max(35,(sample.accuracyMeters ?? 35)*2);
      entry.deviations=offRoute ? entry.deviations+1 : 0;
      if(!offRoute && entry.path.length>1) {
        const max=entry.progress+(entry.point ? meters(entry.point,sample)*2+30 : 50);
        const guarded=projectRoute(entry.path,sample,entry.progress,max);
        if(guarded.distance<=Math.max(35,(sample.accuracyMeters ?? 35)*2)) entry.progress=Math.max(entry.progress,guarded.progress);
      }
      entry.sampleTime=time;
      entry.point=sample;
    }
    if (fresh && !entry.pending && (!entry.route || entry.deviations>=3) && now-entry.lastAttempt>=60000) {
      entry.lastAttempt=now;
      const target=entry;
      target.pending=(async()=>{
        try {
          const route=await calculate(sample,destination);
          const path=decodeRoute(route.encodedPolyline);
          if(!Number.isFinite(route.distanceMeters) || route.distanceMeters<0 || !Number.isFinite(route.durationSeconds) || route.durationSeconds<0) throw new Error('INVALID_ROUTE_METRICS');
          target.route=route; target.path=path; target.progress=0; target.point=sample;
          target.revision++; target.deviations=0; target.failed=false;
        } catch { target.failed=true; }
      })();
      try { await target.pending; } finally { target.pending=undefined; }
    } else if(entry.pending) { await entry.pending; }
    const path=remainingPath(entry.path,entry.progress);
    const total=entry.path.reduce((sum,p,i)=>sum+(i ? meters(entry.path[i-1],p):0),0);
    const ratio=total>0 ? Math.max(0,1-entry.progress/total) : 0;
    return {
      route:entry.route,remainingPath:path,revision:entry.revision,
      status:!fresh ? 'STALE_LOCATION' : !entry.route ? 'UNAVAILABLE' : entry.failed ? 'STALE_ROUTE' : entry.deviations>0 ? 'OFF_ROUTE' : 'READY',
      distanceMeters:entry.route ? entry.route.distanceMeters*ratio : null,
      durationSeconds:entry.route ? entry.route.durationSeconds*ratio : null,
    };
  }
}
