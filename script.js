/* ===================== Configuração ===================== */
const URL_INMET = "https://apiprevmet3.inmet.gov.br/avisos/ativos";
const URL_METEO = "https://api.open-meteo.com/v1/forecast";
const TAM_LOTE = 50;
const CONCORRENCIA = 2;
const DIAS_PREVISAO = 16;
const MAX_AMOSTRA = 10;
const TTL_CACHE_MS = 3 * 60 * 60 * 1000;

/* ===================== Mapa ===================== */
const map = L.map("map", { preferCanvas: true }).setView([-23.55, -46.63], 5);

L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 18,
    attribution: "Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri (Thailand), TomTom, 2012"
}).addTo(map);

const camadaMarcadores = L.layerGroup().addTo(map);

/* ===================== Estado e elementos ===================== */
let dados = [];
let renderId = 0;
let alertasPromise = null;
const cacheMeteo = new Map();
const cachePrevisao = new Map();
let abortPrevisao = null;
let diaSelecionado = 0;
let datasPrevisao = [];

const $ = id => document.getElementById(id);
const filtroRegional = $("filtroRegional");
const filtroCluster = $("filtroCluster");
const filtroCidade = $("filtroCidade");
const filtroData = $("filtroData");

/* ===================== Utilitários ===================== */
const normalizar = s =>
    String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ESC[c]);

const chaveCoord = (lat, lon) => `${lat.toFixed(4)}_${lon.toFixed(4)}`;
const fmtData = iso => iso.split("-").reverse().join("/");
const fmtChance = v => (v == null ? "—" : `${v}%`);
const fmtChuva = v => (v == null ? "—" : `${Number(v.toFixed(1))} mm`);
const hojeSP = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

async function executarEmPool(tarefas, limite) {
    let i = 0;
    const workers = Array.from(
        { length: Math.min(limite, tarefas.length) },
        async () => {
            while (i < tarefas.length) await tarefas[i++]();
        }
    );
    await Promise.all(workers);
}

/* ===================== INMET ===================== */
function parseMunicipio(m) {
    if (m && typeof m === "object") {
        return { nome: normalizar(m.nome ?? m.municipio ?? m.name), uf: normalizar(m.uf ?? m.estado) };
    }
    const txt = String(m ?? "").trim();
    // "Abreulândia - TO (1700251)", "Cidade - UF", "Cidade (UF)" ou só "Cidade"
    const r = txt.match(/^(.*?)\s*(?:-\s*([A-Za-z]{2})\b|\(([A-Za-z]{2})\))?\s*(?:\(\d+\))?\s*$/);
    return { nome: normalizar(r?.[1] ?? txt), uf: normalizar(r?.[2] ?? r?.[3] ?? "") };
}

// Só avisos de chuva e vento; "Baixa Umidade", ondas de calor/frio etc. ficam de fora.
const AVISOS_RELEVANTES = /chuva|tempestade|vendaval|granizo|ciclone|tornado|ressaca|ventos|enchente|inunda|alagamento|acumulado/i;

// O JSON "hoje" pode trazer avisos já encerrados; confere a janela inicio/fim (horário de Brasília).
function avisoVigente(a) {
    const t = s => (s ? Date.parse(`${String(s).replace(" ", "T")}:00-03:00`) : NaN);
    const agora = Date.now();
    const ini = t(a.inicio);
    const fim = t(a.fim);
    return !(Number.isFinite(ini) && agora < ini) && !(Number.isFinite(fim) && agora > fim);
}

function listaMunicipios(alerta) {
    const m = alerta?.municipios;
    if (Array.isArray(m)) return m;
    if (typeof m === "string") return m.split(/[;,]/).map(s => s.trim()).filter(Boolean);
    return [];
}

function carregarAlertasINMET() {
    alertasPromise ??= fetch(URL_INMET)
        .then(r => {
            if (!r.ok) throw new Error(`INMET ${r.status}`);
            return r.json();
        })
        .then(json => {
            // Formato esperado: { hoje: [...], futuro: [...] }. Só "hoje" vale como ativo agora.
            let avisos;
            if (Array.isArray(json)) avisos = json;
            else if (Array.isArray(json?.hoje)) avisos = json.hoje;
            else avisos = Object.values(json ?? {}).flat();

            const indice = new Map();
            for (const alerta of avisos) {
                if (!avisoVigente(alerta) || !AVISOS_RELEVANTES.test(alerta.descricao ?? "")) continue;
                for (const m of listaMunicipios(alerta)) {
                    const { nome, uf } = parseMunicipio(m);
                    if (!nome) continue;
                    if (!indice.has(nome)) indice.set(nome, []);
                    indice.get(nome).push({ uf, alerta });
                }
            }
            if (!indice.size) console.warn("INMET: nenhum aviso de chuva/vento vigente (ou formato do JSON mudou):", json);
            return indice;
        })
        .catch(erro => {
            console.error("Erro INMET (se for CORS, use um proxy):", erro);
            return new Map();
        });
    return alertasPromise;
}

function ufDoLocal(local) {
    return normalizar(local.UF ?? local.uf ?? local.nom_uf ?? local.Estado ?? local.estado ?? "");
}

function temAlerta(alertas, local) {
    const lista = alertas.get(normalizar(local.municipio ?? local.nom_municipio ?? local.nom_cidade));
    if (!lista) return false;
    const uf = ufDoLocal(local);
    return lista.some(a => !uf || !a.uf || a.uf === uf);
}

/* ===================== Open-Meteo (em lote) ===================== */
const dormir = ms => new Promise(r => setTimeout(r, ms));

async function fetchComRetry(url, tentativas = 4) {
    let ultimoErro;
    for (let t = 0; t < tentativas; t++) {
        try {
            const resp = await fetch(url);
            if (resp.ok) return resp;
            ultimoErro = new Error(`Open-Meteo ${resp.status}`);
            if (resp.status !== 429 && resp.status < 500) break;
        } catch (erro) {
            ultimoErro = erro;
        }
        if (t < tentativas - 1) await dormir(2000 * 2 ** t);
    }
    throw ultimoErro;
}

function lerCache(k) {
    try {
        const e = JSON.parse(localStorage.getItem(`meteo:${k}`));
        if (!e || e.d0 !== hojeSP() || Date.now() - e.t > TTL_CACHE_MS) return null;
        return { chuva: e.chuva, chance: e.chance };
    } catch { return null; }
}

function salvarCache(k, entrada, d0) {
    try {
        localStorage.setItem(`meteo:${k}`, JSON.stringify({ t: Date.now(), d0, ...entrada }));
    } catch { /* storage cheio ou indisponível */ }
}

function lerDatasCache() {
    try {
        const e = JSON.parse(localStorage.getItem("meteo:datas"));
        return e && e.datas?.[0] === hojeSP() ? e.datas : [];
    } catch { return []; }
}

async function obterMeteoLote(itens, aoLote) {
    const vistos = new Set();
    const pendentes = [];

    if (!datasPrevisao.length) datasPrevisao = lerDatasCache();

    for (const { lat, lon } of itens) {
        const k = chaveCoord(lat, lon);
        if (cacheMeteo.has(k) || vistos.has(k)) continue;
        vistos.add(k);
        const salvo = lerCache(k);
        if (salvo) { cacheMeteo.set(k, salvo); continue; }
        pendentes.push({ lat, lon, k });
    }

    let falhas = 0;
    const tarefas = [];
    for (let i = 0; i < pendentes.length; i += TAM_LOTE) {
        const lote = pendentes.slice(i, i + TAM_LOTE);

        tarefas.push(async () => {
            const lats = lote.map(c => c.lat.toFixed(4)).join(",");
            const lons = lote.map(c => c.lon.toFixed(4)).join(",");
            try {
                const resp = await fetchComRetry(
                    `${URL_METEO}?latitude=${lats}&longitude=${lons}` +
                    `&daily=precipitation_sum,precipitation_probability_max` +
                    `&forecast_days=${DIAS_PREVISAO}&timezone=America/Sao_Paulo`
                );

                const json = await resp.json();
                const lista = Array.isArray(json) ? json : [json];

                lote.forEach((c, idx) => {
                    const daily = lista[idx]?.daily;
                    if (!daily) return;
                    if (!datasPrevisao.length && Array.isArray(daily.time)) {
                        datasPrevisao = daily.time;
                        try { localStorage.setItem("meteo:datas", JSON.stringify({ datas: daily.time })); } catch { /* ignora */ }
                    }
                    const entrada = {
                        chuva: (daily.precipitation_sum ?? []).map(v => Number(v ?? 0)),
                        // null = sem previsão de probabilidade para aquele dia (não é 0%)
                        chance: (daily.precipitation_probability_max ?? []).map(v => (v == null ? null : Number(v)))
                    };
                    cacheMeteo.set(c.k, entrada);
                    salvarCache(c.k, entrada, daily.time?.[0]);
                });
            } catch (erro) {
                falhas++;
                console.error("Erro Open-Meteo:", erro);
            }
            aoLote?.();
        });
    }

    await executarEmPool(tarefas, CONCORRENCIA);
    if (falhas) console.warn(`Open-Meteo: ${falhas} lote(s) sem resposta; serão tentados de novo na próxima renderização.`);
}

/* ===================== Status ===================== */
function obterStatus(chuva) {
    if (chuva == null) return { texto: "Sem dados", classe: "status-seco", cor: "#9E9E9E" };
    if (chuva < 20) return { texto: "Normal", classe: "status-seco", cor: "#4CAF50" };
    if (chuva < 50) return { texto: "Atenção", classe: "status-atencao", cor: "#FF9800" };
    return { texto: "Crítico", classe: "status-critico", cor: "#F44336" };
}

// Níveis em que o alerta INMET pinta o marcador de vermelho (em Regionais só aparece o aviso no popup/card).
const NIVEIS_ALERTA_PINTA = new Set(["Clusters", "Cidades"]);

const STATUS_ALERTA = { texto: "ALERTA INMET", classe: "status-critico", cor: "#8B0000" };

/* ===================== KPIs ===================== */
function atualizarKPIs() {
    const regionais = new Set();
    const clusters = new Set();
    const cidades = new Set();

    for (const item of dados) {
        regionais.add(item.nom_Regional);
        clusters.add(item.nom_cluster);
        cidades.add(item.nom_cidade);
    }

    $("totalRegionais").textContent = regionais.size;
    $("totalClusters").textContent = clusters.size;
    $("totalCidades").textContent = cidades.size;
}

/* ===================== Filtros ===================== */
function preencherSelect(select, valores, textoPadrao) {
    const opcoes = [`<option value="">${textoPadrao}</option>`];
    for (const v of valores) opcoes.push(`<option value="${esc(v)}">${esc(v)}</option>`);
    select.innerHTML = opcoes.join("");
}

const unicosOrdenados = valores => [...new Set(valores)].filter(Boolean).sort((a, b) => a.localeCompare(b, "pt-BR"));

function agrupar(lista, fn) {
    const mapa = new Map();
    for (const item of lista) {
        const k = fn(item);
        if (!mapa.has(k)) mapa.set(k, []);
        mapa.get(k).push(item);
    }
    return [...mapa.values()].map(membros => ({ rep: membros[0], membros }));
}

function obterGrupos() {
    const regional = filtroRegional.value;
    const cluster = filtroCluster.value;
    const cidade = filtroCidade.value;

    if (!regional) return agrupar(dados, i => i.nom_Regional);

    const daRegional = dados.filter(i => i.nom_Regional === regional);
    if (!cluster) return agrupar(daRegional, i => i.nom_cluster);

    const doCluster = daRegional.filter(i => i.nom_cluster === cluster);
    const cidades = cidade ? doCluster.filter(i => i.nom_cidade === cidade) : doCluster;
    return cidades.map(c => ({ rep: c, membros: [c] }));
}

function carregarRegionais() {
    preencherSelect(filtroRegional, unicosOrdenados(dados.map(i => i.nom_Regional)), "Todas as Regionais");
}

function aoMudarRegional() {
    const regional = filtroRegional.value;

    preencherSelect(filtroCidade, [], "Todas as Cidades");
    filtroCidade.disabled = true;

    if (regional) {
        const clusters = unicosOrdenados(
            dados.filter(i => i.nom_Regional === regional).map(i => i.nom_cluster)
        );
        preencherSelect(filtroCluster, clusters, "Todos os Clusters");
    } else {
        preencherSelect(filtroCluster, [], "Todos os Clusters");
    }
    filtroCluster.disabled = !regional;

    atualizarTela(obterGrupos());
}

function aoMudarCluster() {
    const regional = filtroRegional.value;
    const cluster = filtroCluster.value;

    if (cluster) {
        const cidades = unicosOrdenados(
            dados
                .filter(i => i.nom_Regional === regional && i.nom_cluster === cluster)
                .map(i => i.nom_cidade)
        );
        preencherSelect(filtroCidade, cidades, "Todas as Cidades");
    } else {
        preencherSelect(filtroCidade, [], "Todas as Cidades");
    }
    filtroCidade.disabled = !cluster;

    atualizarTela(obterGrupos());
}

filtroRegional.addEventListener("change", aoMudarRegional);
filtroCluster.addEventListener("change", aoMudarCluster);
filtroCidade.addEventListener("change", () => atualizarTela(obterGrupos()));

/* ===================== Renderização ===================== */
function nomeExibido(local) {
    if (!filtroRegional.value) return local.nom_Regional;
    if (!filtroCluster.value) return local.nom_cluster;
    return local.nom_cidade;
}

const coordValida = local => {
    const lat = Number(local.Latitude);
    const lon = Number(local.Longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    // Latitude sem sinal negativo no JSON (ex.: 23.62 em vez de -23.62) cai na África.
    return { lat: lat > 5.5 && lon < -30 && lon > -75 ? -lat : lat, lon };
};

function resumirGrupo(grupo, alertas) {
    const pontos = [];
    for (const local of grupo.membros) {
        const c = coordValida(local);
        if (c) pontos.push({ local, ...c });
    }
    if (!pontos.length) return null;

    let chuva = null;
    let chance = null;
    let cidadesEmAlerta = 0;

    for (const { local, lat, lon } of pontos) {
        const meteo = cacheMeteo.get(chaveCoord(lat, lon));
        const c = meteo?.chuva[diaSelecionado];
        const p = meteo?.chance[diaSelecionado];
        if (c != null) chuva = chuva == null ? c : Math.max(chuva, c);
        if (p != null) chance = chance == null ? p : Math.max(chance, p);
        if (diaSelecionado === 0 && temAlerta(alertas, local)) cidadesEmAlerta++;
    }

    return {
        lat: pontos.reduce((s, p) => s + p.lat, 0) / pontos.length,
        lon: pontos.reduce((s, p) => s + p.lon, 0) / pontos.length,
        chuva,
        chance,
        cidadesEmAlerta,
        totalCidades: pontos.length
    };
}

let popupAberto = false;
map.on("popupopen", () => { popupAberto = true; });
map.on("popupclose", () => { popupAberto = false; });

// Em regionais e clusters busca a previsão de no máximo MAX_AMOSTRA cidades por grupo.
function amostrar(grupos) {
    const itens = [];
    for (const g of grupos) {
        const validos = [];
        for (const local of g.membros) {
            const c = coordValida(local);
            if (c) validos.push({ local, ...c });
        }
        if (MAX_AMOSTRA && validos.length > MAX_AMOSTRA) {
            const passo = validos.length / MAX_AMOSTRA;
            for (let i = 0; i < MAX_AMOSTRA; i++) itens.push(validos[Math.floor(i * passo)]);
        } else {
            itens.push(...validos);
        }
    }
    return itens;
}

async function atualizarTela(grupos, ajustarZoom = true) {
    const id = ++renderId;
    const itens = amostrar(grupos);

    const alertas = await carregarAlertasINMET();
    if (id !== renderId) return;

    desenhar(grupos, alertas, ajustarZoom);

    await obterMeteoLote(itens, () => {
        if (id === renderId && !popupAberto) desenhar(grupos, alertas, false);
    });
    if (id !== renderId) return;

    desenhar(grupos, alertas, ajustarZoom);
}

function desenhar(grupos, alertas, ajustarZoom) {
    camadaMarcadores.clearLayers();
    atualizarBannerData();

    const rotuloData = datasPrevisao[diaSelecionado]
        ? fmtData(datasPrevisao[diaSelecionado])
        : "hoje";

    let nivel = "Regionais";
    if (filtroRegional.value) nivel = "Clusters";
    if (filtroCluster.value) nivel = "Cidades";

    $("contador").innerHTML =
        `<i class="fa-solid fa-map-location-dot"></i> ${grupos.length} ${nivel}`;

    const agregado = nivel !== "Cidades";
    const cards = [];
    const marcadores = [];

    for (const grupo of grupos) {
        const r = resumirGrupo(grupo, alertas);
        if (!r) continue;

        const { rep } = grupo;
        const nome = esc(nomeExibido(rep));
        const alertaAtivo = r.cidadesEmAlerta > 0;
        const status = alertaAtivo && NIVEIS_ALERTA_PINTA.has(nivel) ? STATUS_ALERTA : obterStatus(r.chuva);
        const textoAlerta = agregado
            ? `ALERTA INMET ATIVO (${r.cidadesEmAlerta} de ${r.totalCidades} cidades)`
            : "ALERTA INMET ATIVO";
        const rotuloVolume = agregado ? "Maior volume previsto" : "Volume Previsto";
        const rotuloChance = agregado ? "Maior chance de chuva" : "Chance de Chuva";

        const marker = L.circleMarker([r.lat, r.lon], {
            radius: 10,
            color: status.cor,
            fillColor: status.cor,
            fillOpacity: 0.7,
            weight: 2
        });

        marker.bindPopup(`
            <strong>${nome}</strong> <small>(${rotuloData})</small><br>
            ${rotuloVolume}: ${fmtChuva(r.chuva)}<br>
            ${rotuloChance}: ${fmtChance(r.chance)}<br>
            Status: ${status.texto}<br>
            ${alertaAtivo ? `<span style="color:#8B0000"><b>${textoAlerta}</b></span>` : ""}
        `);
        marker.on("click", () => carregarPrevisao16Dias(r.lat, r.lon));

        marcadores.push(marker);

        cards.push(`
<div class="card">
    <h4><i class="fa-solid fa-location-dot"></i> ${nome}</h4>
    ${alertaAtivo
        ? `<p style="background:#8B0000;color:white;padding:8px;border-radius:5px;font-weight:bold;">${textoAlerta}</p>`
        : ""}
    <p><i class="fa-solid fa-building"></i> ${esc(rep.nom_Regional) || "-"}</p>
    ${agregado && !filtroCluster.value && filtroRegional.value
        ? ""
        : `<p><i class="fa-solid fa-layer-group"></i> ${esc(rep.nom_cluster) || "-"}</p>`}
    <p><i class="fa-solid fa-cloud-rain"></i> ${rotuloVolume}: ${fmtChuva(r.chuva)}</p>
    <p><i class="fa-solid fa-percent"></i> ${rotuloChance}: ${fmtChance(r.chance)}</p>
    <p class="${status.classe}"><i class="fa-solid fa-circle-info"></i> Status: ${status.texto}</p>
</div>`);
    }

    $("cards-container").innerHTML = cards.join("");
    marcadores.forEach(m => camadaMarcadores.addLayer(m));

    if (ajustarZoom && marcadores.length > 0) {
        map.fitBounds(L.featureGroup(marcadores).getBounds(), {
            padding: [40, 40],
            maxZoom: 6
        });
    }
}

/* ===================== Previsão de 16 dias ===================== */
async function carregarPrevisao16Dias(lat, lon) {
    const container = $("previsao16dias");
    if (!container) return;

    abortPrevisao?.abort();
    abortPrevisao = new AbortController();
    const { signal } = abortPrevisao;

    const k = chaveCoord(lat, lon);
    container.textContent = "Carregando previsão...";

    try {
        let previsao = cachePrevisao.get(k);

        if (!previsao) {
            const resp = await fetch(
                `${URL_METEO}?latitude=${lat}&longitude=${lon}` +
                `&current=relative_humidity_2m,wind_speed_10m` +
                `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,uv_index_max` +
                `&forecast_days=16&timezone=America/Sao_Paulo`,
                { signal }
            );
            if (!resp.ok) throw new Error(`Open-Meteo ${resp.status}`);
            previsao = await resp.json();
            cachePrevisao.set(k, previsao);
        }

        const { daily, current } = previsao;

        $("tempMax").textContent = daily.temperature_2m_max[0] + "°C";
        $("tempMin").textContent = daily.temperature_2m_min[0] + "°C";
        $("umidade").textContent = current.relative_humidity_2m + "%";
        $("vento").textContent = current.wind_speed_10m + " km/h";
        $("uv").textContent = daily.uv_index_max[0] ?? "—";
        $("probChuva").textContent = fmtChance(daily.precipitation_probability_max[0]);

        container.innerHTML = daily.time.map((dia, i) => {
            const [ano, mes, d] = dia.split("-");
            const chance = daily.precipitation_probability_max[i];
            const volume = Number(daily.precipitation_sum[i] ?? 0);

            return `
<div class="dia-previsao${i === diaSelecionado ? " ativo" : ""}" data-dia="${i}" tabindex="0" role="button" title="Ver o mapa neste dia">
    <div><strong>${d}/${mes}/${ano}</strong></div>
    <div class="chance">${fmtChance(chance)}</div>
    <div class="volume">${volume.toFixed(1)} mm</div>
</div>`;
        }).join("");

    } catch (erro) {
        if (erro.name === "AbortError") return;
        console.error(erro);
        container.textContent = "Erro ao carregar previsão.";
    }
}

/* ===================== Seleção de data ===================== */
function nomeSemana(iso) {
    const s = new Date(`${iso}T12:00:00`)
        .toLocaleDateString("pt-BR", { weekday: "short" })
        .replace(".", "");
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function preencherDatas() {
    if (filtroData.dataset.pronto || !datasPrevisao.length) return;

    filtroData.innerHTML = datasPrevisao.map((iso, i) => {
        const [, mes, dia] = iso.split("-");
        const curto = `${dia}/${mes}`;
        const rotulo = i === 0 ? `Hoje · ${curto}`
            : i === 1 ? `Amanhã · ${curto}`
            : `${nomeSemana(iso)} · ${curto}`;
        return `<option value="${i}">${rotulo}</option>`;
    }).join("");

    filtroData.value = String(diaSelecionado);
    filtroData.disabled = false;
    filtroData.dataset.pronto = "1";
}

function atualizarBannerData() {
    preencherDatas();

    const el = $("dataSelecionada");
    if (!el) return;

    const iso = datasPrevisao[diaSelecionado];
    const rotulo = iso ? fmtData(iso) : "";

    el.classList.toggle("outro-dia", diaSelecionado !== 0);
    el.innerHTML = diaSelecionado === 0
        ? `<span><i class="fa-solid fa-calendar-day"></i> Mapa exibindo: <strong>Hoje</strong>${rotulo ? ` (${rotulo})` : ""}</span>`
        : `<span><i class="fa-solid fa-calendar-day"></i> Mapa exibindo: <strong>${rotulo}</strong></span>
           <button type="button" id="btnHoje">Voltar para hoje</button>`;
}

function marcarDiaAtivo() {
    $("previsao16dias").querySelectorAll(".dia-previsao[data-dia]").forEach(el =>
        el.classList.toggle("ativo", Number(el.dataset.dia) === diaSelecionado)
    );
}

function selecionarDia(i) {
    if (i === diaSelecionado) return;
    diaSelecionado = i;
    filtroData.value = String(i);
    marcarDiaAtivo();
    atualizarTela(obterGrupos(), false);
}

const linhaDoEvento = e => e.target.closest(".dia-previsao[data-dia]");

$("previsao16dias").addEventListener("click", e => {
    const linha = linhaDoEvento(e);
    if (linha) selecionarDia(Number(linha.dataset.dia));
});

$("previsao16dias").addEventListener("keydown", e => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const linha = linhaDoEvento(e);
    if (!linha) return;
    e.preventDefault();
    selecionarDia(Number(linha.dataset.dia));
});

filtroData.addEventListener("change", () => selecionarDia(Number(filtroData.value)));

$("dataSelecionada").addEventListener("click", e => {
    if (e.target.closest("#btnHoje")) selecionarDia(0);
});

/* ===================== Virada de dia ===================== */
document.addEventListener("visibilitychange", () => {
    if (document.hidden || !datasPrevisao.length || datasPrevisao[0] === hojeSP()) return;

    cacheMeteo.clear();
    cachePrevisao.clear();
    datasPrevisao = [];
    diaSelecionado = 0;
    alertasPromise = null;
    delete filtroData.dataset.pronto;
    $("previsao16dias").textContent = "";
    atualizarTela(obterGrupos(), false);
});

/* ===================== Inicialização ===================== */
carregarAlertasINMET();

fetch("regioes.json")
    .then(r => {
        if (!r.ok) throw new Error(`Erro ${r.status} ao carregar regioes.json`);
        return r.json();
    })
    .then(json => {
        dados = json;
        atualizarKPIs();
        carregarRegionais();
        atualizarTela(obterGrupos());
    })
    .catch(erro => {
        console.error(erro);
        const dica = location.protocol === "file:"
            ? "Abra a página por um servidor local (ex.: python -m http.server) em vez de file://."
            : "";
        $("cards-container").innerHTML =
            `<div class="card"><h4>Erro ao carregar dados</h4><p>${esc(erro.message)}</p>${dica ? `<p>${esc(dica)}</p>` : ""}</div>`;
    });