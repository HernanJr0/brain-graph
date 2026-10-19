# Brain Graph — Wallpaper Engine (protótipo)

Wallpaper Web que reaproveita o `src/` do plugin. Nesta etapa ele usa um **grafo demo**; a ponte com o vault vem depois.

## Gerar

```
npm install
npm run build:wallpaper
```

A pasta `wallpaper/dist/` fica pronta (`index.html`, `wallpaper.js`, `styles.css`, `project.json`).

## Testar no Wallpaper Engine

1. Copie o conteúdo de `wallpaper/dist/` para `wallpaper_engine/projects/myprojects/brain_graph_web/` (na pasta da Steam). O Brain Graph aparece na lista de wallpapers e em **Visualizar todos os projetos** no editor.
   Não solte o `project.json` na caixa **Criar papel de parede**: o editor tenta ler como modelo 3D e cria um projeto de cena vazio.
2. Confirme que o cérebro aparece e gira.
3. Toque música e veja se ele respira com o volume e dispara reações nas batidas.
4. Painel de propriedades: Paleta, Sensibilidade ao áudio, Brilho (halo), Rotação automática, Superfície do cérebro (padrão: desligada) e Interação com o mouse (padrão: desligada; ligada, o mouse gira a câmera e destaca nós).

## O que verificar (e anotar)

- Aparece algo? Se a tela ficar preta, abra o DevTools: em **Configurações → Geral**, defina a **CEF devtools port** (ex.: 9222), aplique o wallpaper e abra `http://localhost:9222` no Chrome/Edge. O clique direito na pré-visualização do editor não abre menu.
- FPS e uso de GPU em 1080p e 4K (o renderer limita a ~30 fps quando só há pulsos ambientes).
- `fetch('http://127.0.0.1:8080')` a partir do console funciona? (decide o desenho da ponte)
- Escrever/ler `localStorage` persiste entre reinícios do Wallpaper Engine? (plano B do snapshot)
- A versão do Chromium embutido (`navigator.userAgent`).

## Testar no navegador

Abra `wallpaper/dist/index.html`. `?audio=1` simula uma batida; `?n=600` muda o número de notas.
