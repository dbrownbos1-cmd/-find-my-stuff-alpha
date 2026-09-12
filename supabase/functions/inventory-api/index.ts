import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS'
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  const transientAuthError = (error: any) => !!error &&
    (!error.status || error.status >= 500 || error.name === 'AuthRetryableFetchError');
  let authResult = await supabase.auth.getUser(jwt);
  // Retry only authentication, before any inventory writes have started.
  if (transientAuthError(authResult.error)) {
    authResult = await supabase.auth.getUser(jwt);
  }
  const user = authResult.data?.user;
  if (authResult.error || !user) {
    if (transientAuthError(authResult.error)) {
      return json({ error: 'Sign-in service temporarily unavailable. Your list has not been saved. Keep this screen open and try Save again shortly.' }, 503);
    }
    return json({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(req.url);
  const action = url.searchParams.get('action') || 'inventory';

  async function signed(path: string | null | undefined) {
    if (!path) return null;
    const { data, error } = await supabase.storage.from('inventory-photos').createSignedUrl(path, 3600);
    if (error) return null;
    return data?.signedUrl || null;
  }

  async function currentInventory(spotId: string) {
    const { data, error } = await supabase.from('items').select('id,name,quantity,is_active,created_at').eq('current_spot_id', spotId).eq('is_active', true).order('created_at');
    if (error) throw error;
    return data || [];
  }

  try {
    if (req.method === 'GET' && action === 'places') {
      const { data, error } = await supabase
        .from('places')
        .select('id,name,place_type,created_at')
        .eq('user_id', user.id)
        .order('created_at');
      if (error) throw error;
      return json({ places: data || [] });
    }

    if (req.method === 'GET' && action === 'inventory') {
      const { data, error } = await supabase
        .from('spots')
        .select('id,name,position,primary_photo_path,created_at,updated_at,place:places(id,name,place_type),area:areas(id,name),items(id,name,quantity,is_active,created_at)')
        .eq('is_active', true)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return json({ spots: data || [] });
    }

    if (req.method === 'GET' && action === 'spot-detail') {
      const spotId = String(url.searchParams.get('spot_id') || '');
      if (!spotId) return json({ error: 'spot_id is required' }, 400);
      const spotQ = await supabase.from('spots')
        .select('id,name,position,primary_photo_path,created_at,updated_at,place:places(id,name,place_type),area:areas(id,name)')
        .eq('id', spotId).eq('is_active', true).single();
      if (spotQ.error) throw spotQ.error;
      const items = await currentInventory(spotId);
      const snapsQ = await supabase.from('spot_snapshots').select('id,photo_path,inventory,snapshot_type,created_at').eq('spot_id', spotId).order('created_at', { ascending: false });
      if (snapsQ.error) throw snapsQ.error;
      const snapshots = await Promise.all((snapsQ.data || []).map(async (s: any) => ({ ...s, photo_url: await signed(s.photo_path) })));
      return json({ spot: { ...spotQ.data, photo_url: await signed(spotQ.data.primary_photo_path), items, snapshots } });
    }

    if (req.method === 'GET' && action === 'search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return json({ results: [] });
      const { data, error } = await supabase
        .from('items')
        .select('id,name,quantity,current_spot_id,spot:spots(id,name,position,primary_photo_path,place:places(id,name),area:areas(id,name))')
        .eq('is_active', true)
        .ilike('name', `%${q}%`)
        .limit(50);
      if (error) throw error;
      return json({ results: data || [] });
    }

    if (req.method === 'POST' && action === 'spot') {
      const body = await req.json();
      const requestedPlaceId = body.place_id ? String(body.place_id).trim() : '';
      const placeName = String(body.place || '').trim();
      const placeType = String(body.place_type || 'home').trim();
      const areaName = String(body.area || '').trim();
      const spotName = String(body.spot || '').trim();
      const position = body.position ? String(body.position).trim() : null;
      const photoPath = body.photo_path ? String(body.photo_path).trim() : null;
      const items = Array.isArray(body.items) ? body.items.map((x: unknown) => String(x).trim()).filter(Boolean) : [];
      if (!placeName || !areaName || !spotName || !items.length) return json({ error: 'place, area, spot and items are required' }, 400);

      let place: { id: string } | null = null;
      if (requestedPlaceId) {
        const existing = await supabase.from('places').select('id').eq('user_id', user.id).eq('id', requestedPlaceId).single();
        if (existing.error) throw existing.error;
        place = existing.data;
      } else {
        const allPlaces = await supabase.from('places').select('id,name').eq('user_id', user.id);
        if (allPlaces.error) throw allPlaces.error;
        const normalized = placeName.toLocaleLowerCase().replace(/\s+/g, ' ');
        place = (allPlaces.data || []).find((p: any) => String(p.name).trim().toLocaleLowerCase().replace(/\s+/g, ' ') === normalized) || null;
        if (!place) {
          const ins = await supabase.from('places').insert({ user_id: user.id, name: placeName, place_type: placeType }).select('id').single();
          if (ins.error) throw ins.error;
          place = ins.data;
        }
      }
      let { data: area } = await supabase.from('areas').select('id').eq('user_id', user.id).eq('place_id', place.id).eq('name', areaName).maybeSingle();
      if (!area) {
        const ins = await supabase.from('areas').insert({ user_id: user.id, place_id: place.id, name: areaName }).select('id').single();
        if (ins.error) throw ins.error;
        area = ins.data;
      }
      const spotIns = await supabase.from('spots').insert({ user_id: user.id, place_id: place.id, area_id: area.id, name: spotName, position, primary_photo_path: photoPath }).select('id,name,position').single();
      if (spotIns.error) throw spotIns.error;
      const itemRows = items.map((name: string) => ({ user_id: user.id, current_spot_id: spotIns.data.id, name, normalized_name: name.toLowerCase() }));
      const itemIns = await supabase.from('items').insert(itemRows).select('id,name');
      if (itemIns.error) throw itemIns.error;
      const snap = await supabase.from('spot_snapshots').insert({ user_id: user.id, spot_id: spotIns.data.id, photo_path: photoPath, inventory: items, snapshot_type: 'inventory' });
      if (snap.error) throw snap.error;
      return json({ spot: spotIns.data, items: itemIns.data }, 201);
    }

    if (req.method === 'POST' && action === 'photo-only') {
      const body = await req.json();
      const spotId = String(body.spot_id || '');
      const photoPath = String(body.photo_path || '');
      if (!spotId || !photoPath.startsWith(user.id + '/') || photoPath.includes('..')) {
        return json({ error: 'A photo belonging to your account is required' }, 400);
      }
      const target = await supabase.from('spots').select('id').eq('id', spotId).eq('user_id', user.id).single();
      if (target.error) return json({ error: 'Location not found' }, 404);
      const items = await currentInventory(spotId);
      const snapshot = await supabase.from('spot_snapshots').insert({
        user_id: user.id, spot_id: spotId, photo_path: photoPath,
        inventory: items.map((x: any) => x.name), snapshot_type: 'photo'
      });
      if (snapshot.error) throw snapshot.error;
      const update = await supabase.from('spots').update({ primary_photo_path: photoPath }).eq('id', spotId).eq('user_id', user.id);
      if (update.error) throw update.error;
      return json({ ok: true });
    }

    if (req.method === 'DELETE' && action === 'photo') {
      const snapshotId = String(url.searchParams.get('snapshot_id') || '');
      const snapshot = await supabase.from('spot_snapshots').select('id,photo_path').eq('id', snapshotId).eq('user_id', user.id).single();
      if (snapshot.error) return json({ error: 'Photo not found' }, 404);
      const path = snapshot.data.photo_path;
      if (!path) return json({ ok: true });
      if (!path.startsWith(user.id + '/') || path.includes('..')) return json({ error: 'Photo does not belong to your account' }, 403);
      const removal = await supabase.storage.from('inventory-photos').remove([path]);
      if (removal.error) throw removal.error;
      // A photo can appear in more than one snapshot. Keep the inventory history,
      // but detach every reference to the deleted file within this account.
      const snapshots = await supabase.from('spot_snapshots').update({ photo_path: null }).eq('user_id', user.id).eq('photo_path', path);
      if (snapshots.error) throw snapshots.error;
      const spots = await supabase.from('spots').update({ primary_photo_path: null }).eq('user_id', user.id).eq('primary_photo_path', path);
      if (spots.error) throw spots.error;
      return json({ ok: true });
    }

    if (req.method === 'POST' && action === 'add-items') {
      const body = await req.json();
      const spotId = String(body.spot_id || '');
      const photoPath = body.photo_path ? String(body.photo_path).trim() : null;
      const items = Array.isArray(body.items) ? body.items.map((x: unknown) => String(x).trim()).filter(Boolean) : [];
      if (!spotId || !items.length) return json({ error: 'spot_id and items are required' }, 400);
      const target = await supabase.from('spots').select('id').eq('id', spotId).single();
      if (target.error) throw target.error;
      const rows = items.map((name: string) => ({ user_id: user.id, current_spot_id: spotId, name, normalized_name: name.toLowerCase() }));
      const ins = await supabase.from('items').insert(rows).select('id,name');
      if (ins.error) throw ins.error;
      const allItems = await currentInventory(spotId);
      const snap = await supabase.from('spot_snapshots').insert({ user_id: user.id, spot_id: spotId, photo_path: photoPath, inventory: allItems.map((x: any) => x.name), snapshot_type: 'add' });
      if (snap.error) throw snap.error;
      if (photoPath) {
        const upd = await supabase.from('spots').update({ primary_photo_path: photoPath }).eq('id', spotId);
        if (upd.error) throw upd.error;
      }
      return json({ items: ins.data, inventory: allItems }, 201);
    }

    if (req.method === 'POST' && action === 'replace-items') {
      const body = await req.json();
      const spotId = String(body.spot_id || '');
      const photoPath = body.photo_path ? String(body.photo_path).trim() : null;
      const items = Array.isArray(body.items) ? body.items.map((x: unknown) => String(x).trim()).filter(Boolean) : [];
      if (!spotId || !items.length) return json({ error: 'spot_id and items are required' }, 400);
      const off = await supabase.from('items').update({ is_active: false }).eq('current_spot_id', spotId).eq('is_active', true);
      if (off.error) throw off.error;
      const rows = items.map((name: string) => ({ user_id: user.id, current_spot_id: spotId, name, normalized_name: name.toLowerCase() }));
      const ins = await supabase.from('items').insert(rows).select('id,name');
      if (ins.error) throw ins.error;
      const snap = await supabase.from('spot_snapshots').insert({ user_id: user.id, spot_id: spotId, photo_path: photoPath, inventory: items, snapshot_type: 'rescan' });
      if (snap.error) throw snap.error;
      if (photoPath) {
        const upd = await supabase.from('spots').update({ primary_photo_path: photoPath }).eq('id', spotId);
        if (upd.error) throw upd.error;
      }
      return json({ items: ins.data }, 201);
    }

    if (req.method === 'PATCH' && action === 'place') {
      const body = await req.json();
      const placeId = String(body.place_id || '');
      const name = String(body.name || '').trim();
      if (!placeId || !name) return json({ error: 'place_id and name are required' }, 400);
      const upd = await supabase.from('places').update({ name }).eq('id', placeId).eq('user_id', user.id).select('id,name,place_type').single();
      if (upd.error) throw upd.error;
      return json({ place: upd.data });
    }

    if (req.method === 'PATCH' && action === 'area') {
      const body = await req.json();
      const areaId = String(body.area_id || '');
      const name = String(body.name || '').trim();
      if (!areaId || !name) return json({ error: 'area_id and name are required' }, 400);
      const upd = await supabase.from('areas').update({ name }).eq('id', areaId).eq('user_id', user.id).select('id,name,place_id').single();
      if (upd.error) throw upd.error;
      return json({ area: upd.data });
    }

    if (req.method === 'PATCH' && action === 'spot') {
      const body = await req.json();
      const spotId = String(body.spot_id || '');
      if (!spotId) return json({ error: 'spot_id is required' }, 400);
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = String(body.name).trim();
      if (body.position !== undefined) patch.position = body.position ? String(body.position).trim() : null;
      if (body.photo_path !== undefined) patch.primary_photo_path = body.photo_path ? String(body.photo_path).trim() : null;
      if (!Object.keys(patch).length) return json({ error: 'No changes supplied' }, 400);
      const upd = await supabase.from('spots').update(patch).eq('id', spotId).eq('user_id', user.id).select('id,name,position,primary_photo_path').single();
      if (upd.error) throw upd.error;
      return json({ spot: upd.data });
    }

    if (req.method === 'PATCH' && action === 'move-item') {
      const body = await req.json();
      const itemId = String(body.item_id || '');
      const toSpotId = String(body.to_spot_id || '');
      if (!itemId || !toSpotId) return json({ error: 'item_id and to_spot_id are required' }, 400);
      const upd = await supabase.from('items').update({ current_spot_id: toSpotId }).eq('id', itemId).eq('user_id', user.id).select('id,name,current_spot_id').single();
      if (upd.error) throw upd.error;
      return json({ item: upd.data });
    }

    if (req.method === 'PATCH' && action === 'item') {
      const body = await req.json();
      const itemId = String(body.item_id || '');
      const name = String(body.name || '').trim();
      if (!itemId || !name) return json({ error: 'item_id and name are required' }, 400);
      const upd = await supabase.from('items').update({ name, normalized_name: name.toLowerCase() }).eq('id', itemId).eq('user_id', user.id).select('id,name').single();
      if (upd.error) throw upd.error;
      return json({ item: upd.data });
    }

    if (req.method === 'DELETE' && action === 'item') {
      const itemId = String(url.searchParams.get('item_id') || '');
      if (!itemId) return json({ error: 'item_id is required' }, 400);
      const upd = await supabase.from('items').update({ is_active: false }).eq('id', itemId).eq('user_id', user.id);
      if (upd.error) throw upd.error;
      return json({ ok: true });
    }

    return json({ error: 'Unknown route' }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : 'Unexpected error' }, 500);
  }
});
