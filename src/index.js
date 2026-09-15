const CALL_RESULT_FIELD_TITLE = 'Результат звонка';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'cache-control': 'no-store',
    },
  });
}

function normalizeText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function isEmptyEnumLabel(value) {
  const v = normalizeText(value);
  return ['', 'не выбрано', 'не выбран', 'не выбрана', 'не выбрано.'].includes(v);
}

async function restCall(domain, accessToken, method, params = {}) {
  const cleanDomain = String(domain || '').replace(/^https?:\/\//i, '').trim();

  if (!cleanDomain || !accessToken) {
    return {
      error: 'NO_AUTH',
      error_description: 'Нет данных авторизации Bitrix24',
    };
  }

  const response = await fetch(`https://${cleanDomain}/rest/${method}.json`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json',
    },
    body: JSON.stringify({
      ...params,
      auth: accessToken,
    }),
  });

  let data;
  try {
    data = await response.json();
  } catch {
    return {
      error: 'BAD_RESPONSE',
      error_description: `HTTP ${response.status}`,
    };
  }

  return data;
}

async function findCallResultField(domain, accessToken) {
  let start = 0;

  for (let page = 0; page < 20; page++) {
    const response = await restCall(
      domain,
      accessToken,
      'crm.lead.userfield.list',
      {
        order: {
          SORT: 'ASC',
          ID: 'ASC',
        },
        filter: {
          USER_TYPE_ID: 'enumeration',
          LANG: 'ru',
        },
        start,
      }
    );

    if (response.error) {
      return null;
    }

    const items = Array.isArray(response.result)
      ? response.result
      : [];

    for (const field of items) {
      const labels = [
        field.EDIT_FORM_LABEL,
        field.LIST_COLUMN_LABEL,
        field.LIST_FILTER_LABEL,
        field.LABEL,
        field.TITLE,
      ];

      let found = false;

      for (let label of labels) {
        if (label && typeof label === 'object') {
          label = label.ru || '';
        }

        if (normalizeText(label) === normalizeText(CALL_RESULT_FIELD_TITLE)) {
          found = true;
          break;
        }
      }

      if (!found) continue;

      if (Array.isArray(field.LIST)) {
        return field;
      }

      const fieldId = Number(field.ID || 0);

      if (fieldId > 0) {
        const getResponse = await restCall(
          domain,
          accessToken,
          'crm.lead.userfield.get',
          { id: fieldId }
        );

        if (!getResponse.error && getResponse.result) {
          return getResponse.result;
        }
      }

      return field;
    }

    if (
      response.next === undefined
      ||
      response.next === null
      ||
      response.next === false
    ) {
      break;
    }

    start = Number(response.next || 0);
  }

  return null;
}

function invalidEnumIds(field) {
  const list = Array.isArray(field?.LIST)
    ? field.LIST
    : [];

  const invalid = [];

  for (const item of list) {
    const id = String(item?.ID ?? item?.id ?? '');
    const value = String(item?.VALUE ?? item?.value ?? '');

    if (id && isEmptyEnumLabel(value)) {
      invalid.push(id);
    }
  }

  return invalid;
}

function callResultFilled(value, invalidIds) {
  if (Array.isArray(value)) {
    const values = value
      .map(v => String(v ?? '').trim())
      .filter(Boolean);

    return values.some(v => !invalidIds.includes(v));
  }

  const v = String(value ?? '').trim();

  return v !== '' && !invalidIds.includes(v);
}

async function activityGuard(request) {
  let form;

  try {
    form = await request.formData();
  } catch {
    return json({
      ok: false,
      error: 'bad_form_data',
    }, 400);
  }

  const event = String(form.get('event') || '').toLowerCase();

  if (event !== 'oncrmactivityupdate') {
    return json({
      ok: true,
      ignored: 'wrong_event',
    });
  }

  const activityId = Number(
    form.get('data[FIELDS][ID]')
    ||
    form.get('data[fields][ID]')
    ||
    0
  );

  const domain = String(form.get('auth[domain]') || '');
  const accessToken = String(form.get('auth[access_token]') || '');

  if (!activityId || !domain || !accessToken) {
    return json({
      ok: false,
      error: 'missing_event_data',
    });
  }

  const activityResponse = await restCall(
    domain,
    accessToken,
    'crm.activity.get',
    { id: activityId }
  );

  if (activityResponse.error) {
    return json({
      ok: false,
      error: 'activity_get_failed',
      detail: activityResponse.error,
    });
  }

  const activity = activityResponse.result || {};

  const typeId = Number(activity.TYPE_ID || 0);
  const ownerTypeId = Number(activity.OWNER_TYPE_ID || 0);
  const leadId = Number(activity.OWNER_ID || 0);
  const completed = String(activity.COMPLETED || 'N').toUpperCase();

  if (
    typeId !== 2
    ||
    ownerTypeId !== 1
    ||
    !leadId
    ||
    completed !== 'Y'
  ) {
    return json({
      ok: true,
      ignored: 'not_completed_lead_call',
    });
  }

  const leadResponse = await restCall(
    domain,
    accessToken,
    'crm.lead.get',
    { id: leadId }
  );

  if (leadResponse.error) {
    return json({
      ok: false,
      error: 'lead_get_failed',
    });
  }

  const lead = leadResponse.result || {};
  const field = await findCallResultField(domain, accessToken);

  if (!field) {
    return json({
      ok: false,
      error: 'call_result_field_not_found',
    });
  }

  const fieldCode = String(field.FIELD_NAME || '').trim();

  if (!fieldCode) {
    return json({
      ok: false,
      error: 'call_result_field_code_empty',
    });
  }

  const invalidIds = invalidEnumIds(field);
  const leadValue = lead[fieldCode];

  if (callResultFilled(leadValue, invalidIds)) {
    return json({
      ok: true,
      allowed: true,
      leadId,
      activityId,
    });
  }

  const reopen = await restCall(
    domain,
    accessToken,
    'crm.activity.update',
    {
      id: activityId,
      fields: {
        OWNER_ID: leadId,
        OWNER_TYPE_ID: ownerTypeId,
        TYPE_ID: typeId,
        COMPLETED: 'N',
      },
    }
  );

  if (reopen.error) {
    return json({
      ok: false,
      error: 'activity_reopen_failed',
      detail: reopen.error,
    });
  }

  await restCall(
    domain,
    accessToken,
    'crm.timeline.comment.add',
    {
      fields: {
        ENTITY_ID: leadId,
        ENTITY_TYPE: 'lead',
        COMMENT:
          '⚠️ Звонок не завершён. Перед завершением заполните обязательное поле «Результат звонка» в карточке лида.',
      },
    }
  );

  return json({
    ok: true,
    allowed: false,
    reopened: true,
    leadId,
    activityId,
  });
}

async function assetResponse(env, request, assetPath) {
  const url = new URL(request.url);
  url.pathname = assetPath;
  url.search = '';

  const assetRequest = new Request(url.toString(), {
    method: 'GET',
    headers: request.headers,
  });

  const response = await env.ASSETS.fetch(assetRequest);
  const headers = new Headers(response.headers);

  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  headers.delete('x-frame-options');
  headers.delete('content-security-policy');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.toLowerCase();

    if (path === '/health.php' || path === '/health') {
      return json({
        ok: true,
        service: 'bitrix-crm-tools',
        platform: 'cloudflare-workers',
        time: new Date().toISOString(),
      });
    }

    if (path === '/activity-guard.php') {
      if (request.method !== 'POST') {
        return json({
          ok: true,
          endpoint: 'activity-guard',
        });
      }

      return activityGuard(request);
    }

    // Старый диагностический обработчик больше не нужен.
    // Возвращаем 200, пока install.php удаляет старые события.
    if (
      path === '/lead-status-logger.php'
      ||
      path === '/diag-auth-save.php'
      ||
      path === '/lead-log-view.php'
    ) {
      return json({
        ok: true,
        disabled: true,
      });
    }

    const routes = {
      '/': '/index.html',
      '/index.php': '/index.html',
      '/index.html': '/index.html',
      '/install.php': '/install.html',
      '/install.html': '/install.html',
      '/call-result.php': '/call-result.html',
      '/call-result.html': '/call-result.html',
      '/testdrive.php': '/testdrive.html',
      '/testdrive.html': '/testdrive.html',
      '/commercial.php': '/commercial.html',
      '/commercial.html': '/commercial.html',
      '/call-complete.php': '/call-complete.html',
      '/call-complete.html': '/call-complete.html',
    };

    const assetPath = routes[path];

    if (assetPath) {
      return assetResponse(env, request, assetPath);
    }

    return new Response('Not found', {
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=UTF-8',
      },
    });
  },
};
