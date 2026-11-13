'use strict';

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

// Reuse Telegram API TCP/TLS connections across callbacks and panel edits.
// Pooling avoids repeated handshakes; it does not establish the cause of a
// particular slow request. Phase timings below provide that evidence.
const HTTPS_AGENT = new https.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: 32, maxFreeSockets: 8 });
const HTTP_AGENT = new http.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: 32, maxFreeSockets: 8 });
// Process-local IDs and numeric metadata only: never persist sockets or payloads.
const socketEvidence = new WeakMap();
let nextSocketId = 0;

function agentFor(url) {
  return url.protocol === 'http:' ? HTTP_AGENT : HTTPS_AGENT;
}
const { logStructured, sanitizeError, extractErrorCode } = require('./structuredLogger');

function parseTelegramEnvelope(data, method, response) {
  const invalid = () => ({ error: Object.assign(new Error('Telegram API returned invalid response'), {
    code: 'TELEGRAM_INVALID_RESPONSE', ambiguous: true, statusCode: response.statusCode
  }) });
  let parsed;
  try { parsed = JSON.parse(data); } catch (parseErr) {
    logStructured(null, {
      level: 'warn',
      component: 'telegram_api',
      event: 'telegram_api_parse_failed',
      operation: method,
      result: 'invalid_json',
      errorCode: 'JSON_PARSE_ERROR',
      // JSON.parse errors may contain a response-body excerpt.
      sanitizedError: 'Telegram API returned invalid JSON'
    });
    return invalid();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.ok !== 'boolean'
    || (parsed.ok === true && (!Object.prototype.hasOwnProperty.call(parsed, 'result') || parsed.result === null))) return invalid();
  if (parsed.ok === false) {
    const description = typeof parsed.description === 'string' ? parsed.description : '';
    const error = Object.assign(new Error(`Telegram API ${method} failed${description ? `: ${description}` : ''}`), {
      code: 'TELEGRAM_API_ERROR', statusCode: response.statusCode, telegramCode: parsed.error_code, description, ambiguous: false
    });
    if (parsed.parameters?.retry_after !== undefined) error.retryAfter = parsed.parameters.retry_after;
    logStructured(null, {
      level: 'error',
      component: 'telegram_api',
      event: 'telegram_api_rejected',
      operation: method,
      result: 'rejected',
      errorCode: String(parsed.error_code),
      sanitizedError: description,
      method,
      error_code: parsed.error_code,
      description
    });
    return { error };
  }
  return { result: parsed.result };
}

// One lifecycle owns the complete-request deadline, settlement and stream
// cleanup for ordinary API writes, multipart writes and binary downloads.
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
function transfer(url, { method = 'POST', body, headers, timeoutMs = 30_000, maxBytes = DEFAULT_MAX_RESPONSE_BYTES, decode, file = false, onTiming, signal, agent }) {
  const abortError = () => Object.assign(new Error('Telegram API request aborted'), { name: 'AbortError', code: 'ABORT_ERR', ambiguous: true });
  if (signal?.aborted) return Promise.reject(abortError());
  const client = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    let response, deadline, settled = false, bytes = 0;
    const started=performance.now(),timing={deadlineMs:timeoutMs};
    let socketState;
    const elapsed=()=>Math.round(performance.now()-started);
    const chunks = [];
    const uncertain = (message, code) => Object.assign(new Error(message), {
      code, ambiguous: true, ...(response ? { statusCode: response.statusCode } : {})
    });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onSignalAbort);
      req.removeListener('timeout', onTimeout);
      req.setTimeout?.(0);
      response?.removeListener('data', onData);
      response?.removeListener('end', onEnd);
      response?.removeListener('aborted', onAborted);
      chunks.length = 0;
      // Keep error guards until close: Node may emit error after aborted/destroy.
      if (socketState) socketState.lastEnd = performance.now();
      const responseWaitMs = timing.ttfbMs !== undefined && timing.requestFinishedMs !== undefined
        ? Math.max(0, timing.ttfbMs - timing.requestFinishedMs) : undefined;
      try{onTiming?.({...timing,responseWaitMs,responseBytes:bytes,httpStatus:response?.statusCode,
        telegramCode:error?.telegramCode,responseMessageId:Number.isSafeInteger(result?.message_id)?result.message_id:undefined,updateCount:Array.isArray(result)?result.length:undefined,totalMs:elapsed(),reusedSocket:Boolean(req.reusedSocket),
        code:error?.code||null,receipt:!error});}catch{}
      if (error) reject(error); else resolve(result);
    };
    const fail = error => {
      if (settled) return;
      finish(error);
      response?.destroy?.();
      req.destroy();
    };
    const onSignalAbort = () => fail(abortError());
    const onTimeout = () => fail(uncertain(file ? 'Telegram file download timeout' : 'Telegram API timeout', 'TELEGRAM_TIMEOUT'));
    const onRequestError = error => {timing.causeCode=String(error?.code||'UNKNOWN');fail(uncertain(file ? 'Telegram file download failed' : 'Telegram API transport failed', file ? 'TELEGRAM_FILE_ERROR' : 'TELEGRAM_TRANSPORT_ERROR'));};
    const onAborted = () => fail(uncertain(file ? 'Telegram file transfer aborted' : 'Telegram API response aborted', file ? 'TELEGRAM_FILE_ERROR' : 'TELEGRAM_INVALID_RESPONSE'));
    const onResponseError = () => fail(uncertain(file ? 'Telegram file transfer failed' : 'Telegram API response failed', file ? 'TELEGRAM_FILE_ERROR' : 'TELEGRAM_INVALID_RESPONSE'));
    const onData = chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (maxBytes !== undefined && bytes > maxBytes) {
        return fail(Object.assign(new Error('الملف أكبر من الحجم المسموح.'), { code: 'FILE_TOO_LARGE' }));
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      const { error, result } = decode(Buffer.concat(chunks), response);
      finish(error, result);
    };
    const req = client.request({
      hostname: url.hostname, port: url.port || undefined, path: `${url.pathname}${url.search}`,
      method, headers, timeout: timeoutMs, agent: agent === undefined ? agentFor(url) : agent
    }, res => {
      response = res;timing.ttfbMs=elapsed();
      res.on('data', onData);
      res.on('end', onEnd);
      res.on('aborted', onAborted);
      res.on('error', onResponseError);
      res.once('close', () => {
        if (!settled) onAborted();
        res.removeListener('error', onResponseError);
      });
    });
    req.once('socket', socket => {
      const now = performance.now();
      socketState = socketEvidence.get(socket);
      if (!socketState) {
        socketState = { id: ++nextSocketId, created: now, requests: 0 };
        socketEvidence.set(socket, socketState);
      }
      timing.socketWaitMs = elapsed();
      timing.socketId = socketState.id;
      timing.socketAgeMs = Math.round(now - socketState.created);
      timing.socketIdleMs = socketState.lastEnd === undefined ? null : Math.round(now - socketState.lastEnd);
      timing.socketRequests = ++socketState.requests;
      timing.socketDestroyed = socket.destroyed;
      timing.socketWritable = socket.writable;
      timing.remoteFamily = socket.remoteFamily;
      if (!req.reusedSocket) {
        socket.once('lookup', () => timing.dnsMs = elapsed());
        socket.once('connect', () => { timing.tcpMs = elapsed(); timing.remoteFamily = socket.remoteFamily; });
        socket.once('secureConnect', () => timing.tlsMs = elapsed());
      }
    });
    // 'finish' means handed to the local transport, not acknowledged remotely.
    req.once('finish', () => timing.requestFinishedMs = elapsed());
    req.on('timeout', onTimeout);
    req.on('error', onRequestError);
    req.once('close', () => req.removeListener('error', onRequestError));
    // Socket timeouts reset on each chunk; bound the complete response as well.
    if (timeoutMs > 0) deadline = setTimeout(onTimeout, timeoutMs);
    signal?.addEventListener('abort', onSignalAbort, { once: true });
    if (signal?.aborted) onSignalAbort();
    if (!settled) req.end(body);
  });
}

function request(token, method, params = {}, options = {}) {
  if (!token) return Promise.reject(Object.assign(new Error('TELEGRAM_BOT_TOKEN is required'), { code: 'CONFIG_ERROR' }));
  const navigation=require('./telegram').navigationContext.getStore();
  const operationLimit = method === 'answerCallbackQuery' ? 4000 : undefined;
  const configuredDeadline = operationLimit ? Math.min(options.timeoutMs > 0 ? options.timeoutMs : operationLimit, operationLimit) : options.timeoutMs;
  const writeDeadline=navigation?Math.min(configuredDeadline||30000,options.navigationTimeoutMs||4000):configuredDeadline;
  const timeoutMs = method === 'getUpdates' && Number.isFinite(params?.timeout)
    ? Math.max(options.timeoutMs || 30_000, (params.timeout + 15) * 1000)
    : writeDeadline;
  const receivedAt = params._receivedAt || params.receivedAt || options.receivedAt || navigation?.receivedAt;
  const receivedToRequestMs = receivedAt ? Date.now() - receivedAt : undefined;
  if (typeof options.request === 'function') {
    const startReq = performance.now();
    return Promise.resolve(options.request(method, params, { timeoutMs, ...(options.signal ? { signal: options.signal } : {}) }))
      .then(res => {
        const totalMs = Math.round(performance.now() - startReq);
        const ackLatencyMs = (method === 'answerCallbackQuery' && receivedAt) ? Date.now() - receivedAt : undefined;
        try {
          options.onTiming?.({
            operation: method,
            totalMs,
            ackLatencyMs,
            receivedToRequestMs,
            callbackQueryId: params.callback_query_id,
            receipt: true
          });
        } catch {}
        return res;
      })
      .catch(err => {
        const totalMs = Math.round(performance.now() - startReq);
        const ackLatencyMs = (method === 'answerCallbackQuery' && receivedAt) ? Date.now() - receivedAt : undefined;
        try {
          options.onTiming?.({
            operation: method,
            totalMs,
            ackLatencyMs,
            receivedToRequestMs,
            callbackQueryId: params.callback_query_id,
            code: err?.code || 'ERROR',
            receipt: false
          });
        } catch {}
        throw err;
      });
  }
  const url = new URL(`/bot${encodeURIComponent(token)}/${method}`, options.baseUrl || 'https://api.telegram.org');
  const body = JSON.stringify(params);
  if(navigation||method==='getUpdates'||method==='answerCallbackQuery')logStructured(options.logger||null,{
    component:'telegram_api',event:'telegram_http_started',operation:method,
    updateId:navigation?.updateId,incomingMessageId:navigation?.incomingMessageId,
    callbackQueryId:params.callback_query_id,
    navigationVersion:navigation?.version,navigationAction:navigation?.action,
    deadlineMs:timeoutMs??30000,offset:method==='getUpdates'?params.offset:undefined,
    serverWaitSeconds:method==='getUpdates'?params.timeout:undefined,
    receivedToRequestMs
  });
  return transfer(url, {
    body, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeoutMs,
    signal: options.signal, agent: options.agentFor?.(url),
    onTiming: timing => {
      const content = params.rich_message?.html ?? params.text ?? '';
      const rows = params.reply_markup?.inline_keyboard ?? params.reply_markup?.keyboard ?? [];
      const ackLatencyMs = (method === 'answerCallbackQuery' && receivedAt) ? Date.now() - receivedAt : undefined;
      options.onTiming?.({operation:method,requestBytes:Buffer.byteLength(body),
        contentKind:params.rich_message ? 'rich' : params.text !== undefined ? 'text' : 'none',
        contentBytes:Buffer.byteLength(String(content)),
        markupBytes:params.reply_markup ? Buffer.byteLength(JSON.stringify(params.reply_markup)) : 0,
        buttonCount:Array.isArray(rows) ? rows.reduce((n,row)=>n+(Array.isArray(row)?row.length:0),0) : 0,
        navigationVersion:navigation?.version,navigationAction:navigation?.action,updateId:navigation?.updateId,incomingMessageId:navigation?.incomingMessageId,receivedToRequestMs,
        ackLatencyMs,
        callbackQueryId:params.callback_query_id,
        handlerQueueMs:navigation?.handlerQueueMs,...timing});
    },
    maxBytes: options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    decode: (data, response) => parseTelegramEnvelope(data.toString('utf8'), method, response)
  });
}

function createTelegramApi(token, options = {}) {
  if (!token) throw Object.assign(new Error('TELEGRAM_BOT_TOKEN is required'), { code: 'CONFIG_ERROR' });
  // Each API owns its pools; close only after the caller drains its tasks.
  const ownedAgents = [];
  const lifetime = new AbortController();let closed=false;
  const closedError=()=>Object.assign(new Error('Telegram API closed'),{code:'ABORT_ERR',name:'AbortError',ambiguous:true});
  const makeAgent = (Agent, injected) => {
    if (injected !== undefined) return injected;
    const agent = new Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: 32, maxFreeSockets: 8 });
    ownedAgents.push(agent);
    return agent;
  };
  if (!options.agentFor) {
    const httpAgent = makeAgent(http.Agent, options.httpAgent);
    const httpsAgent = makeAgent(https.Agent, options.httpsAgent);
    options = { ...options, agentFor: url => url.protocol === 'http:' ? httpAgent : httpsAgent };
  }
  let lastTiming=0;const timingCallback=options.onTiming;options={...options,onTiming:timing=>{timingCallback?.(timing);if(timing.code||timing.operation==='getUpdates'||timing.operation.startsWith('editMessage')||require('./telegram').navigationContext.getStore()||Date.now()-lastTiming>30000){lastTiming=Date.now();try{(options.logger||console).log?.(JSON.stringify({event:'telegram_http_timing',...timing}));}catch{}}}};
  const requestCounts = Object.create(null);
  let stylesSupported = options.inlineStyles !== false;
  const queues = new Map(); const nextSend = new Map();
  const nextFastSend = new Map(); const nextBackgroundSend = new Map();
  let lastWriteLog=0;
  const messageEditChains = new Map();
  const serializeMessageEdit = (chatId, messageId, fn) => {
    if (!chatId || !messageId) return fn();
    const key = `${chatId}:${messageId}`;
    const previous = messageEditChains.get(key) || Promise.resolve();
    // Ordering must settle even when the separately returned operation fails.
    let currentResolve;
    const currentPromise = new Promise(resolve => { currentResolve = resolve; });
    messageEditChains.set(key, currentPromise);

    return (async () => {
      try {
        await previous.catch(() => {});
        if (closed) throw closedError();
        return await fn();
      } finally {
        currentResolve();
        if (messageEditChains.get(key) === currentPromise) {
          messageEditChains.delete(key);
        }
      }
    })();
  };
  const wait = ms => {
    if(closed)return Promise.resolve();
    return new Promise(resolve=>{let timer;const done=()=>{clearTimeout(timer);lifetime.signal.removeEventListener('abort',done);resolve();};
      lifetime.signal.addEventListener('abort',done,{once:true});
      if(options.sleep)Promise.resolve(options.sleep(ms)).then(done,done);else timer=setTimeout(done,ms);
    });
  };
  const blockedUntil=new Map();
  const sendBuckets=new Map();
  function reserveSend(chat,navigation,isCurrent){
    const existing=sendBuckets.get(chat);
    if(!existing){sendBuckets.set(chat,{tokens:1,at:Date.now()});return null;}
    const now=Date.now();existing.tokens=Math.min(2,existing.tokens+(now-existing.at)/1100);existing.at=now;
    if(existing.tokens>=1&&!(blockedUntil.get(chat)>now)){existing.tokens-=1;return null;}
    return waitForPermit(chat,navigation,isCurrent);
  }
  async function waitForPermit(chat,navigation,isCurrent){
    let bucket=sendBuckets.get(chat);if(!bucket){bucket={tokens:2,at:Date.now()};sendBuckets.set(chat,bucket);}
    for(;;){if(closed)return;if((navigation&&!navigation.isCurrent())||(isCurrent&&!isCurrent()))return;const now=Date.now();bucket.tokens=Math.min(2,bucket.tokens+(now-bucket.at)/1100);bucket.at=now;
      const delay=Math.max(0,(blockedUntil.get(chat)||0)-now,bucket.tokens>=1?0:(1-bucket.tokens)*1100);
      if(!delay){bucket.tokens-=1;return;}
      await wait(Math.ceil(delay));
      if((navigation&&!navigation.isCurrent())||(isCurrent&&!isCurrent()))return;
      // Deterministic injected sleeps may not advance wall time.
      if(options.sleep){bucket.tokens=Math.max(bucket.tokens,1);bucket.at=Date.now();}
    }
  }
  const limitedRequest = async (method, params, isCurrent, requestOptions) => {
    const budgetMs = method === 'answerCallbackQuery' ? Math.min(4000, requestOptions?.timeoutMs > 0 ? requestOptions.timeoutMs : options.timeoutMs > 0 ? options.timeoutMs : 4000) : requestOptions?.operationBudgetMs;
    const deadlineAt = budgetMs > 0 ? performance.now() + budgetMs : undefined;
    const isSuperseded = () => {
      const nav = require('./telegram').navigationContext.getStore();
      return Boolean((nav && !nav.isCurrent()) || (isCurrent && !isCurrent()));
    };
    for (let attempt = 0; ; attempt++) {
      if(closed)throw closedError();
      if(isSuperseded())return {superseded:true};
      try {
        requestCounts[method]=(requestCounts[method]||0)+1;
        const signal=requestOptions?.signal?AbortSignal.any([lifetime.signal,requestOptions.signal]):lifetime.signal;
        const remainingMs = deadlineAt === undefined ? undefined : attempt === 0 ? budgetMs : Math.max(1, deadlineAt - performance.now());
        return await request(token, method, params, {...options,...requestOptions,...(remainingMs === undefined ? {} : {timeoutMs: remainingMs}),signal});
      }
      catch (error) {
        if (error.telegramCode === 429 && Number.isFinite(error.retryAfter) && error.retryAfter >= 0 && params?.chat_id != null) {
          const blockMs = Math.max(1, error.retryAfter) * 1000;
          const chatKey = String(params.chat_id);
          blockedUntil.set(chatKey, Math.max(blockedUntil.get(chatKey) || 0, Date.now() + blockMs));
        }
        if (error.telegramCode !== 429 || !Number.isFinite(error.retryAfter) || error.retryAfter < 0 || error.retryAfter > 60 || attempt >= 2) throw error;
        if (requestOptions?.background === true || isSuperseded()) throw error;
        const delayMs = Math.max(1, error.retryAfter) * 1000;
        // A definite rejection may be retried only inside the short operation budget;
        // retain the chat cooldown even when this operation cannot wait for it.
        if (deadlineAt !== undefined && performance.now() + delayMs >= deadlineAt) throw error;
        logStructured(options.logger || null, {
          level: 'warn',
          component: 'telegram_api',
          event: 'telegram_api_rate_limit_retry',
          operation: method,
          result: 'retried',
          durationMs: delayMs,
          retryCount: attempt + 1,
          errorCode: '429',
          sanitizedError: sanitizeError(error),
          suppressionReason: `rate_limited_retry_after_${error.retryAfter}s`
        });
        await wait(delayMs);
        if (closed) throw closedError();
        if (isSuperseded()) return { superseded: true };
      } finally {
        if(method==='getUpdates')try{(options.logger||console).log?.(JSON.stringify({event:'telegram_request_counts',counts:{...requestCounts}}));}catch{}
      }
    }
  };
  const perform = async (method, params, isCurrent, requestOptions) => {
    const keyboardTypes = ['inline_keyboard', 'keyboard'];
    const styled = keyboardTypes.some(type => params?.reply_markup?.[type]?.some(row => row.some(button => button?.style)));
    const withoutStyles = () => {
      const reply_markup = { ...params.reply_markup };
      for (const type of keyboardTypes) {
        if (!Array.isArray(reply_markup[type])) continue;
        reply_markup[type] = reply_markup[type].map(row => row.map(button => {
          if (!button || typeof button !== 'object') return button;
          const { style, ...plain } = button;
          // Reply labels are exact routing keys; only legacy inline labels
          // need visible glyphs when the API rejects optional button tinting.
          if (type === 'inline_keyboard') plain.text = ({ 'تشغيل': '🟢 تشغيل', 'إيقاف': '🔴 إيقاف', 'تحديث الحالة': '🔄 تحديث الحالة' })[plain.text] || plain.text;
          return plain;
        }));
      }
      return { ...params, reply_markup };
    };
    const payload = styled && !stylesSupported ? withoutStyles() : params;
    try { return await limitedRequest(method, payload, isCurrent, requestOptions); }
    catch (error) {
      if(method==='editMessageText'&&error.telegramCode===400&&/message is not modified/i.test(error.description||error.message))return {message_id:params.message_id,unchanged:true};
      // Retry only a definite schema rejection of styling, never a timeout or
      // a generic 400: the first send may otherwise already have landed.
      if (styled && stylesSupported && error.telegramCode === 400 && /style|BUTTON_STYLE|unknown field.*style/i.test(error.message)) {
        stylesSupported = false;
        logStructured(options.logger || null, {
          level: 'warn',
          component: 'telegram_api',
          event: 'telegram_api_style_unsupported_retry',
          operation: method,
          result: 'retried',
          retryCount: 1,
          errorCode: '400',
          sanitizedError: sanitizeError(error),
          suppressionReason: 'inline_styles_rejected_by_api'
        });
        return limitedRequest(method, withoutStyles(), isCurrent, requestOptions);
      }
      throw error;
    }
  };
  const pickQueuedJobIndex = queue => {
    let index = queue.findIndex(job => !job.background && job.fastLane);
    if (index < 0) index = queue.findIndex(job => !job.background && job.controlPriority);
    if (index < 0) index = queue.findIndex(job => !job.background);
    if (index < 0) index = queue.findIndex(job => job.controlPriority);
    if (index < 0) index = 0;
    return index;
  };
  const call = (method, params, requestOptions = {}) => {
    if(closed)return Promise.reject(closedError());
    const { _background=false, _navigation=false, _cleanup=false, _controlPriority=false, _isCurrent, _receivedAt, ...payload } = params;
    if (_receivedAt && !requestOptions.receivedAt) requestOptions = { ...requestOptions, receivedAt: _receivedAt };
    const context = require('./telegram').navigationContext;
    // Retirement is detached from the navigation that used to own the panel.
    if (_cleanup && context.getStore()) return context.run(undefined, () => call(method, params, requestOptions));
    if (_cleanup) {
      const timeoutMs = Math.min(3000, options.timeoutMs > 0 ? options.timeoutMs : 3000, requestOptions.timeoutMs > 0 ? requestOptions.timeoutMs : 3000);
      requestOptions = { ...requestOptions, timeoutMs, operationBudgetMs: timeoutMs, background: true };
    } else if (_background && requestOptions.background === undefined) {
      requestOptions = { ...requestOptions, background: true };
    } else if (_navigation && !_background && requestOptions.operationBudgetMs == null) {
      const navBudget = options.navigationTimeoutMs > 0 ? options.navigationTimeoutMs : Math.min(4000, options.timeoutMs > 0 ? options.timeoutMs : 4000);
      requestOptions = { ...requestOptions, operationBudgetMs: navBudget };
    }
    const navigation=context.getStore();
    const queuedAt=Date.now();
    navigation?.onSend?.();
    // Preserve chat flood pacing; interactive replies overtake queued import notices.
    // An in-flight Telegram request cannot safely be cancelled or replayed.
    if ((!options.paceWrites && (options.request || options.baseUrl)) || !['sendMessage', 'sendRichMessage', 'editMessageText'].includes(method)) return (navigation&&!navigation.isCurrent())||(_isCurrent&&!_isCurrent())?Promise.resolve({superseded:true}):perform(method, payload, _isCurrent, requestOptions);
    if(navigation)logStructured(options.logger||null,{component:'telegram_api',event:'telegram_write_queued',operation:method,
      updateId:navigation.updateId,incomingMessageId:navigation.incomingMessageId,
      navigationVersion:navigation.version,navigationAction:navigation.action});
    const chatKey=String(payload.chat_id);
    const fastLane=Boolean(navigation)&&_navigation&&!_cleanup;
    const key=chatKey;
    let queue=queues.get(key);
    if(!queue){queue=[];queues.set(key,queue);}
    const operation=new Promise((resolve,reject)=>queue.push({
      method,
      payload,
      background:Boolean(_background||_cleanup),
      fastLane:Boolean(fastLane),
      controlPriority:Boolean(_controlPriority),
      navigation,
      isCurrent:_isCurrent,
      requestOptions,
      queuedAt,
      resolve,
      reject
    }));
    queue.wake?.();
    if(!queue.running){
      queue.running=true;
      void (async()=>{
        while(queue.length){
          if(closed)break;
          let index=pickQueuedJobIndex(queue);
          if(queue[index]?.background){
            if(queue.backgroundFlight){
              await Promise.race([queue.backgroundFlight,new Promise(resolve=>{queue.wake=resolve;})]);
              queue.wake=null;
              if(queue.backgroundFlight&&!queue.some(job=>!job.background))continue;
            }
            index=pickQueuedJobIndex(queue);
          }
          if(closed||!queue.length)break;
          const candidateJob=queue[index];
          if((candidateJob.navigation&&!candidateJob.navigation.isCurrent())||(candidateJob.isCurrent&&!candidateJob.isCurrent())){
            queue.splice(index,1);
            candidateJob.resolve({superseded:true});
            continue;
          }

          const isFast=candidateJob.fastLane&&!candidateJob.background;
          const nextAllowed=isFast
            ?(nextFastSend.get(chatKey)||0)
            :Math.max(nextSend.get(chatKey)||0,nextBackgroundSend.get(chatKey)||0);
          const delay=Math.max(0,Math.max(nextAllowed,blockedUntil.get(chatKey)||0)-Date.now());
          if(candidateJob.fastLane&&candidateJob.requestOptions?.operationBudgetMs>0&&delay>=candidateJob.requestOptions.operationBudgetMs){
            queue.splice(index,1);
            const retrySec=Math.max(1,Math.ceil(delay/1000));
            candidateJob.reject(Object.assign(new Error(`Too Many Requests: retry after ${retrySec}`),{telegramCode:429,retryAfter:retrySec,ambiguous:false}));
            continue;
          }
          if(delay)await wait(delay);
          if(closed||!queue.length)break;

          const dispatchIndex=pickQueuedJobIndex(queue);
          const job=queue.splice(dispatchIndex,1)[0];

          if((job.navigation&&!job.navigation.isCurrent())||(job.isCurrent&&!job.isCurrent())){job.resolve({superseded:true});continue;}
          if(job.method!=='editMessageText'){const permit=reserveSend(chatKey,job.navigation,job.isCurrent);if(permit)await permit;}
          if((job.navigation&&!job.navigation.isCurrent())||(job.isCurrent&&!job.isCurrent())){job.resolve({superseded:true});continue;}
          if(closed){job.reject(closedError());continue;}

          const now=Date.now();
          if(job.fastLane&&!job.background){
            nextFastSend.set(chatKey,now+250);
            nextSend.set(chatKey,now+250);
          }else if(job.background){
            nextBackgroundSend.set(chatKey,now+1100);
            nextSend.set(chatKey,now+1100);
          }else{
            nextFastSend.set(chatKey,now+250);
            nextBackgroundSend.set(chatKey,now+1100);
            nextSend.set(chatKey,now+1100);
          }

          const started=Date.now();
          const sending=(async()=>{
            let receipt;
            try{receipt=await require('./telegram').navigationContext.run(job.navigation,()=>perform(job.method,job.payload,job.isCurrent,job.requestOptions));job.resolve(receipt);}catch(error){job.reject(error);}
            if(job.navigation||Date.now()-lastWriteLog>30000){lastWriteLog=Date.now();try{(options.logger||console).log?.(JSON.stringify({event:'telegram_write_latency',operation:job.method,updateId:job.navigation?.updateId,incomingMessageId:job.navigation?.incomingMessageId,navigationVersion:job.navigation?.version,navigationAction:job.navigation?.action,networkMs:Date.now()-started,sendQueueMs:started-job.queuedAt,pacedWaitMs:delay,localBeforeSendMs:job.navigation?job.queuedAt-job.navigation.receivedAt:undefined,handlerQueueMs:job.navigation?.handlerQueueMs,databaseMs:job.navigation?.databaseMs||0,databaseCalls:job.navigation?.databaseCalls||0,totalToReceiptMs:job.navigation?Date.now()-job.navigation.receivedAt:undefined,receipt:Boolean(receipt?.message_id??receipt?.result?.message_id)}));}catch{}}
          })();
          // Background notifications must not hold navigation behind a slow reply.
          // Starts remain paced; at most one background request per chat is in flight.
          if(!job.background)await sending;
          else {queue.backgroundFlight=sending;sending.finally(()=>{if(queue.backgroundFlight===sending)queue.backgroundFlight=null;if(!queue.running&&!queue.length&&queues.get(key)===queue)queues.delete(key);});}

        }
        // Leave the queue available until its last background request settles.
        queue.running=false;
        if(!queue.length && queues.get(key)===queue && !queue.backgroundFlight)queues.delete(key);
      })();
    }
    return operation;
  };
  return {
    close: () => {
      if(closed)return;closed=true;lifetime.abort();
      messageEditChains.clear();
      for(const queue of queues.values()){for(const job of queue.splice(0))job.reject(closedError());queue.wake?.();}
      for (const agent of ownedAgents.splice(0)) agent.destroy();
    },
    sendDocument: async ({ chat_id, filename, content }) => {
      if(closed)throw closedError();
      requestCounts.sendDocument=(requestCounts.sendDocument||0)+1;
      const boundary = 'yj-' + require('node:crypto').randomBytes(12).toString('hex');
      const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chat_id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`), Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const url = new URL(`/bot${encodeURIComponent(token)}/sendDocument`, options.baseUrl || 'https://api.telegram.org');
      // Never replay multipart sends: a lost response can follow acceptance.
      return transfer(url, {
        body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length }, timeoutMs: options.timeoutMs, agent: options.agentFor(url), signal:lifetime.signal,
        decode: (data, response) => parseTelegramEnvelope(data.toString('utf8'), 'sendDocument', response)
      });
    },
    getMe: () => call('getMe', {}),
    getUpdates: (params, { signal } = {}) => limitedRequest('getUpdates', params, undefined, { signal }),
    sendRichMessage: (params, requestOptions) => {
      const { text, parse_mode, entities, ...rest } = params;
      return call('sendRichMessage', rest, requestOptions);
    },
    sendMessage: (params, requestOptions) => {
      if (params.rich_message) {
        const { text, parse_mode, entities, ...rest } = params;
        return call('sendRichMessage', rest, requestOptions);
      }
      return call('sendMessage', params, requestOptions);
    },
    editMessageText: (params, requestOptions) => {
      const { text, parse_mode, entities, ...rest } = params;
      const targetParams = params.rich_message ? rest : params;
      return serializeMessageEdit(targetParams.chat_id, targetParams.message_id, () => {
        return call('editMessageText', targetParams, requestOptions);
      });
    },
    deleteMessage: (params, requestOptions) => call('deleteMessage', params, requestOptions),
    answerCallbackQuery: (params, requestOptions) => call('answerCallbackQuery', params, requestOptions),
    getFile: (params, requestOptions) => call('getFile', params, requestOptions),
    downloadFileTo: async (filePath, destination, { maxBytes = 20 * 1024 * 1024 } = {}) => {
      if (!/^[A-Za-z0-9_./-]+$/.test(String(filePath)) || String(filePath).split('/').includes('..')) throw new Error('Invalid Telegram file path');
      const fs = require('node:fs');
      const { pipeline } = require('node:stream/promises');
      const { Transform } = require('node:stream');
      const url = new URL(`/file/bot${encodeURIComponent(token)}/${String(filePath).replace(/^\/+/, '')}`, options.baseUrl || 'https://api.telegram.org');
      const temporary = destination + '.part';
      let bytes = 0;
      if(closed)throw closedError();
      const controller = new AbortController();
      const downloadSignal=AbortSignal.any([controller.signal,lifetime.signal]);
      const timer = setTimeout(() => controller.abort(), options.timeoutMs || 120000);
      try {
        await new Promise((resolve, reject) => {
          const req = (url.protocol === 'http:' ? http : https).get(url, { agent: options.agentFor(url), signal: downloadSignal }, res => {
            if (res.statusCode !== 200) { res.destroy(); reject(Object.assign(new Error('Telegram file download failed'), { code:'TELEGRAM_FILE_ERROR' })); return; }
            const limit = new Transform({ transform(chunk, encoding, callback) {
              bytes += chunk.length;
              callback(bytes > maxBytes ? Object.assign(new Error('FILE_TOO_LARGE'), { code:'FILE_TOO_LARGE' }) : null, chunk);
            } });
            pipeline(res, limit, fs.createWriteStream(temporary, { mode:0o600 }), { signal:downloadSignal }).then(resolve,reject);
          });
          req.on('error', () => reject(Object.assign(new Error('Telegram download interrupted'), { code:'TELEGRAM_FILE_ERROR' })));
        });
        await fs.promises.rename(temporary,destination);
        return { bytes };
      } finally {
        clearTimeout(timer);
        await fs.promises.unlink(temporary).catch(() => {});
      }
    },
    downloadFile: async (filePath, { maxBytes = 2 * 1024 * 1024 } = {}) => {
      if (!/^[A-Za-z0-9_./-]+$/.test(String(filePath)) || String(filePath).split('/').includes('..')) throw new Error('Invalid Telegram file path');
      const fileUrl = new URL(`/file/bot${encodeURIComponent(token)}/${String(filePath).replace(/^\/+/, '')}`, options.baseUrl || 'https://api.telegram.org');
      return transfer(fileUrl, {
        method: 'GET', timeoutMs: options.timeoutMs, maxBytes, file: true, agent: options.agentFor(fileUrl), signal:lifetime.signal,
        decode: (data, response) => response.statusCode === 200 ? { result: data } : {
          error: Object.assign(new Error('Telegram file download failed'), {
            code: 'TELEGRAM_FILE_ERROR', statusCode: response.statusCode, ambiguous: false
          })
        }
      });
    }
  };
}

module.exports = { createTelegramApi, request, transfer, DEFAULT_MAX_RESPONSE_BYTES };
