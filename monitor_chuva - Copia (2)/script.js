/* ===================== Configuração ===================== */
const URL_INMET = "https://apiprevmet3.inmet.gov.br/avisos/ativos";
const URL_METEO = "https://api.open-meteo.com/v1/forecast";
const TAM_LOTE = 50;       // coordenadas por requisição ao Open-Meteo
const CONCORRENCIA = 4;    // requisições simultâneas

/* ===================== Mapa ===================== */
const map = L.map("map", { preferCanvas: true }).setView([-23.55, -46.63], 5);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap"
}).addTo(map);

const camadaMarcadores = L.layerGroup().addTo(map);

/* ===================== Estado e elementos ===================== */
let dados = [];
let renderId = 0;                 // descarta renderizações antigas
let alertasPromise = null;        // alertas INMET carregados uma única vez
const cacheMeteo = new Map();     // chuva do dia por coordenada
const cachePrevisao = new Map();  // previsão de 16 dias por coordenada
let abortPrevisao = null;

const $ = id => document.getElementById(id);
const filtroRegional = $("filtroRegional");
const filtroCluster = $("filtroCluster");
const filtroCidade = $("filtroCidade");

/* ===================== Utilitários ===================== */
const normalizar = s =>
    String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ESC[c]);

const chaveCoord = (lat, lon) => `${lat.toFixed(2)}_${lon.toFixed(2)}`;

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
// Baixa uma vez e indexa por nome normalizado: busca O(1) por cidade.
function carregarAlertasINMET() {
    alertasPromise ??= fetch(URL_INMET)
        .then(r => {
            if (!r.ok) throw new Error(`INMET ${r.status}`);
            return r.json();
        })
        .then(json => {
            const indice = new Map();
            for (const alerta of Object.values(json)) {
                if (!Array.isArray(alerta.municipios)) continue;
                for (const m of alerta.municipios) {
                    const k = normalizar(m);
                    if (!indice.has(k)) indice.set(k, alerta);
                }
            }
            return indice;
        })
        .catch(erro => {
            console.error("Erro INMET:", erro);
            return new Map();
        });
    return alertasPromise;
}

/* ===================== Open-Meteo (em lote) ===================== */
async function obterMeteoLote(itens) {
    const vistos = new Set();
    const pendentes = [];

    for (const { lat, lon } of itens) {
        const k = chaveCoord(lat, lon);
        if (cacheMeteo.has(k) || vistos.has(k)) continue;
        vistos.add(k);
        pendentes.push({ lat, lon, k });
    }

    const tarefas = [];
    for (let i = 0; i < pendentes.length; i += TAM_LOTE) {
        const lote = pendentes.slice(i, i + TAM_LOTE);

        tarefas.push(async () => {
            const lats = lote.map(c => c.lat.toFixed(4)).join(",");
            const lons = lote.map(c => c.lon.toFixed(4)).join(",");
            try {
                const resp = await fetch(
                    `${URL_METEO}?latitude=${lats}&longitude=${lons}` +
                    `&daily=precipitation_sum,precipitation_probability_max` +
                    `&forecast_days=1&timezone=America/Sao_Paulo`
                );
                if (!resp.ok) throw new Error(`Open-Meteo ${resp.status}`);

                const json = await resp.json();
                const lista = Array.isArray(json) ? json : [json];

                lote.forEach((c, idx) => {
                    const daily = lista[idx]?.daily;
                    cacheMeteo.set(c.k, {
                        chuva: Number(daily?.precipitation_sum?.[0] || 0),
                        chance: Number(daily?.precipitation_probability_max?.[0] || 0)
                    });
                });
            } catch (erro) {
                // Não grava no cache: a próxima renderização tenta de novo.
                console.error("Erro Open-Meteo:", erro);
            }
        });
    }

    await executarEmPool(tarefas, CONCORRENCIA);
}

const SEM_DADOS = { chuva: 0, chance: 0 };

/* ===================== Status ===================== */
function obterStatus(chuva) {
    if (chuva < 20) return { texto: "Normal", classe: "status-seco", cor: "#4CAF50" };
    if (chuva < 50) return { texto: "Atenção", classe: "status-atencao", cor: "#FF9800" };
    return { texto: "Crítico", classe: "status-critico", cor: "#F44336" };
}

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

// Mantém o último item de cada chave (mesmo comportamento do código original).
const unicosPor = (lista, fn) => [...new Map(lista.map(i => [fn(i), i])).values()];

// Única fonte de verdade para "o que mostrar" conforme os filtros.
function obterRegistros() {
    const regional = filtroRegional.value;
    const cluster = filtroCluster.value;
    const cidade = filtroCidade.value;

    if (!regional) return unicosPor(dados, i => i.nom_Regional);

    const daRegional = dados.filter(i => i.nom_Regional === regional);
    if (!cluster) return unicosPor(daRegional, i => i.nom_cluster);

    const doCluster = daRegional.filter(i => i.nom_cluster === cluster);
    return cidade ? doCluster.filter(i => i.nom_cidade === cidade) : doCluster;
}

function carregarRegionais() {
    const regionais = [...new Set(dados.map(i => i.nom_Regional))].sort();
    preencherSelect(filtroRegional, regionais, "Todas as Regionais");
}

function aoMudarRegional() {
    const regional = filtroRegional.value;

    preencherSelect(filtroCidade, [], "Todas as Cidades");
    filtroCidade.disabled = true;

    if (regional) {
        const clusters = [...new Set(
            dados.filter(i => i.nom_Regional === regional).map(i => i.nom_cluster)
        )].filter(Boolean).sort();
        preencherSelect(filtroCluster, clusters, "Todos os Clusters");
    } else {
        preencherSelect(filtroCluster, [], "Todos os Clusters");
    }
    filtroCluster.disabled = !regional;

    atualizarTela(obterRegistros());
}

function aoMudarCluster() {
    const regional = filtroRegional.value;
    const cluster = filtroCluster.value;

    if (cluster) {
        const cidades = dados
            .filter(i => i.nom_Regional === regional && i.nom_cluster === cluster)
            .map(i => i.nom_cidade);
        preencherSelect(filtroCidade, cidades, "Todas as Cidades");
    } else {
        preencherSelect(filtroCidade, [], "Todas as Cidades");
    }
    filtroCidade.disabled = !cluster;

    atualizarTela(obterRegistros());
}

filtroRegional.addEventListener("change", aoMudarRegional);
filtroCluster.addEventListener("change", aoMudarCluster);
filtroCidade.addEventListener("change", () => atualizarTela(obterRegistros()));

/* ===================== Renderização ===================== */
function nomeExibido(local) {
    if (!filtroRegional.value) return local.nom_Regional;
    if (!filtroCluster.value) return local.nom_cluster;
    return local.nom_cidade;
}

async function atualizarTela(registros) {
    const id = ++renderId;

    // Cada item já com coordenadas numéricas válidas.
    const itens = [];
    for (const local of registros) {
        const lat = Number(local.Latitude);
        const lon = Number(local.Longitude);
        if (Number.isFinite(lat) && Number.isFinite(lon)) itens.push({ local, lat, lon });
    }

    // Alertas e previsão em paralelo; poucas requisições em lote.
    const [alertas] = await Promise.all([
        carregarAlertasINMET(),
        obterMeteoLote(itens)
    ]);

    // Se o usuário mudou o filtro enquanto carregava, descarta este resultado.
    if (id !== renderId) return;

    camadaMarcadores.clearLayers();

    let nivel = "Regionais";
    if (filtroRegional.value) nivel = "Clusters";
    if (filtroCluster.value) nivel = "Cidades";

    $("contador").innerHTML =
        `<i class="fa-solid fa-map-location-dot"></i> ${registros.length} ${nivel}`;

    const cards = [];
    const marcadores = [];

    for (const { local, lat, lon } of itens) {
        const nome = esc(nomeExibido(local));
        const { chuva, chance } = cacheMeteo.get(chaveCoord(lat, lon)) ?? SEM_DADOS;
        const alertaAtivo = alertas.has(normalizar(local.nom_cidade));
        const status = alertaAtivo ? STATUS_ALERTA : obterStatus(chuva);

        const marker = L.circleMarker([lat, lon], {
            radius: 10,
            color: status.cor,
            fillColor: status.cor,
            fillOpacity: 0.7,
            weight: 2
        });

        marker.bindPopup(`
            <strong>${nome}</strong><br>
            Volume Previsto: ${chuva} mm<br>
            Chance de Chuva: ${chance}%<br>
            Status: ${status.texto}<br>
            ${alertaAtivo ? `<span style="color:#8B0000"><b>ALERTA INMET ATIVO</b></span>` : ""}
        `);
        marker.on("click", () => carregarPrevisao16Dias(lat, lon));

        marcadores.push(marker);

        cards.push(`
<div class="card">
    <h4><i class="fa-solid fa-location-dot"></i> ${nome}</h4>
    ${alertaAtivo
        ? `<p style="background:#8B0000;color:white;padding:8px;border-radius:5px;font-weight:bold;">ALERTA INMET ATIVO</p>`
        : ""}
    <p><i class="fa-solid fa-building"></i> ${esc(local.nom_Regional) || "-"}</p>
    <p><i class="fa-solid fa-layer-group"></i> ${esc(local.nom_cluster) || "-"}</p>
    <p><i class="fa-solid fa-cloud-rain"></i> Volume Previsto: ${chuva} mm</p>
    <p><i class="fa-solid fa-percent"></i> Chance de Chuva: ${chance}%</p>
    <p class="${status.classe}"><i class="fa-solid fa-circle-info"></i> Status: ${status.texto}</p>
</div>`);
    }

    // Uma única escrita no DOM e uma única adição de camadas.
    $("cards-container").innerHTML = cards.join("");
    marcadores.forEach(m => camadaMarcadores.addLayer(m));

    if (marcadores.length > 0) {
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

    abortPrevisao?.abort();               // cancela a requisição anterior
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
        $("uv").textContent = daily.uv_index_max[0];
        $("probChuva").textContent = daily.precipitation_probability_max[0] + "%";

        // Monta tudo em memória e escreve no DOM uma vez só.
        container.innerHTML = daily.time.map((dia, i) => {
            const [ano, mes, d] = dia.split("-");
            const chance = daily.precipitation_probability_max[i];
            const classe = chance >= 70 ? "chance-alta" : chance >= 40 ? "chance-media" : "chance-baixa";
            const volume = Number(daily.precipitation_sum[i] ?? 0);

            return `
<div class="dia-previsao">
    <div><strong>${d}/${mes}/${ano}</strong></div>
    <div class="${classe}">${chance}%</div>
    <div class="volume">${volume.toFixed(1)} mm</div>
</div>`;
        }).join("");

    } catch (erro) {
        if (erro.name === "AbortError") return;   // troca de cidade, não é erro
        console.error(erro);
        container.textContent = "Erro ao carregar previsão.";
    }
}

/* ===================== Inicialização ===================== */
// Já dispara os alertas em paralelo com o carregamento do JSON.
carregarAlertasINMET();

fetch("regioes.json")
    .then(r => {
        if (!r.ok) throw new Error(`Erro ${r.status}`);
        return r.json();
    })
    .then(json => {
        dados = json;
        atualizarKPIs();
        carregarRegionais();
        atualizarTela(obterRegistros());
    })
    .catch(erro => {
        console.error(erro);
        $("cards-container").innerHTML =
            `<div class="card"><h4>Erro ao carregar dados</h4><p>${esc(erro.message)}</p></div>`;
    });