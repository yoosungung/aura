'use strict';

/**
 * Aura Admin UI client (ops-only MVP).
 * Calls aura-control-admin HTTP only — does not subscribe to control.resolve.
 */

(function () {
  const state = {
    tenantId: null,
    lastBundleUri: null,
  };

  function el(id) {
    return document.getElementById(id);
  }

  function setBanner() {
    el('active-tenant').textContent = state.tenantId || '(none)';
  }

  function baseUrl() {
    return (el('base-url').value || '').replace(/\/$/, '');
  }

  function token() {
    return el('ops-token').value || '';
  }

  async function api(method, path, body) {
    const headers = {
      authorization: token().startsWith('Bearer ') ? token() : 'Bearer ' + token(),
      'content-type': 'application/json',
    };
    if (state.tenantId) {
      headers['x-aura-tenant-id'] = state.tenantId;
    }
    const res = await fetch(baseUrl() + path, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    return { status: res.status, body: json };
  }

  function show(id, value) {
    el(id).textContent =
      typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  }

  async function loadTenants() {
    const r = await api('GET', '/v1/tenants');
    const sel = el('tenant-select');
    sel.innerHTML = '';
    const tenants = (r.body && r.body.tenants) || [];
    for (const t of tenants) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      sel.appendChild(opt);
    }
    show('bundle-out', r);
  }

  function useTenant() {
    const fromInput = (el('tenant-input').value || '').trim();
    const fromSelect = el('tenant-select').value;
    state.tenantId = fromInput || fromSelect || null;
    setBanner();
  }

  el('btn-load-tenants').addEventListener('click', () => loadTenants().catch(console.error));
  el('btn-set-tenant').addEventListener('click', useTenant);

  el('btn-list-sources').addEventListener('click', async () => {
    show('sources-out', await api('GET', '/v1/sources'));
  });

  el('btn-presign').addEventListener('click', async () => {
    const r = await api('POST', '/v1/bundles/presign', {
      kind: el('src-kind').value,
      name: el('src-name').value,
      version: el('src-version').value,
    });
    if (r.body && r.body.bundle_uri) state.lastBundleUri = r.body.bundle_uri;
    show('bundle-out', r);
  });

  el('btn-create-source').addEventListener('click', async () => {
    let config = {};
    try {
      config = JSON.parse(el('src-config').value || '{}');
    } catch (e) {
      show('bundle-out', { error: 'invalid_config_json', message: String(e.message) });
      return;
    }
    const r = await api('POST', '/v1/sources', {
      kind: el('src-kind').value,
      name: el('src-name').value,
      version: el('src-version').value,
      entrypoint: el('src-entrypoint').value,
      runtime: el('src-runtime').value,
      checksum: el('src-checksum').value,
      bundle_uri: state.lastBundleUri,
      config,
    });
    if (r.body && r.body.source && r.body.source.id) {
      el('src-id').value = r.body.source.id;
    }
    show('bundle-out', r);
  });

  el('btn-activate').addEventListener('click', async () => {
    const id = el('src-id').value;
    show('bundle-out', await api('POST', '/v1/sources/' + encodeURIComponent(id) + '/activate'));
  });

  el('btn-upsert-overlay').addEventListener('click', async () => {
    let config = {};
    try {
      config = JSON.parse(el('ov-config').value || '{}');
    } catch (e) {
      show('overlay-out', { error: 'invalid_config_json' });
      return;
    }
    const id = el('src-id').value;
    const principal = el('ov-principal').value;
    show(
      'overlay-out',
      await api('PUT', '/v1/sources/' + encodeURIComponent(id) + '/overlays/' + encodeURIComponent(principal), {
        config,
        secrets_ref: el('ov-secrets-ref').value || null,
      })
    );
  });

  el('btn-delete-overlay').addEventListener('click', async () => {
    const id = el('src-id').value;
    const principal = el('ov-principal').value;
    show(
      'overlay-out',
      await api(
        'DELETE',
        '/v1/sources/' + encodeURIComponent(id) + '/overlays/' + encodeURIComponent(principal),
        { reason: el('action-reason').value }
      )
    );
  });

  el('btn-retire').addEventListener('click', async () => {
    const id = el('src-id').value;
    show(
      'overlay-out',
      await api('POST', '/v1/sources/' + encodeURIComponent(id) + '/retire', {
        reason: el('action-reason').value,
      })
    );
  });

  setBanner();
  window.AuraAdmin = { state, api, loadTenants, useTenant };
})();
