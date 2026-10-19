# Brain Graph — Wallpaper Engine (protótipo)

Wallpaper Web que reaproveita o `src/` do plugin. Nesta etapa ele usa um **grafo demo**; a ponte com o vault vem depois.

## Gerar

```
npm install
npm run build:wallpaper
```

A pasta `wallpaper/dist/` fica pronta (`index.html`, `wallpaper.js`, `styles.css`, `project.json`).

## Testar no Wallpaper Engine

1. Abra o Wallpaper Engine → **Criar wallpaper** (Wallpaper Editor) → **Abrir** e escolha `wallpaper/dist/project.json`, ou arraste a pasta `dist` para a janela.
2. Confirme que o cérebro aparece e gira.
3. Toque música e veja se ele respira com o volume e dispara reações nas batidas.
4. Painel de propriedades: Paleta, Sensibilidade ao áudio, Brilho (halo), Rotação automática.

## O que verificar (e anotar)

- Aparece algo? Se a tela ficar preta, abra o DevTools do wallpaper (clique direito no editor → Inspecionar) e veja o console.
- FPS e uso de GPU em 1080p e 4K (o renderer limita a ~30 fps quando só há pulsos ambientes).
- `fetch('http://127.0.0.1:8080')` a partir do console funciona? (decide o desenho da ponte)
- Escrever/ler `localStorage` persiste entre reinícios do Wallpaper Engine? (plano B do snapshot)
- A versão do Chromium embutido (`navigator.userAgent`).

## Testar no navegador

Abra `wallpaper/dist/index.html`. `?audio=1` simula uma batida; `?n=600` muda o número de notas.
