# Brain Graph

Graph view leve para o Obsidian, em 2D ou 3D, com o vault desenhado como um cérebro:

- **Regiões:** cada comunidade de notas (ou pasta) vira uma região do córtex.
- **Órfãs:** notas sem links ficam no cerebelo.
- **Fibras:** links longos viram fibras que mergulham para o centro, como a substância branca.
- **Pulsos sinápticos:** sinais percorrem os links e fazem os neurônios piscarem ao chegar.

## Desenvolvimento

```bash
npm install
npm run dev      # watch -> main.js
npm run build    # type-check + build minificado
```

Para testar, copie ou crie um link de `main.js`, `manifest.json` e `styles.css` em
`<vault-de-teste>/.obsidian/plugins/brain-graph/` e ative o plugin em *Plugins da comunidade*.

### Preview fora do Obsidian

`dev/preview.ts` renderiza o grafo com um vault falso, útil para ajustar o visual:

```bash
npx esbuild dev/preview.ts --bundle --format=iife --outfile=dev/preview.js
python -m http.server 5178   # abra http://localhost:5178/dev/index.html
```

Parâmetros de URL: `?n=5000`, `&mode=2d`, `&view=superior|frontal`, `&still` (sem pulsos), `&rotate`.

## Estrutura

| Arquivo | Papel |
| --- | --- |
| `src/brain-shape.ts` | Anatomia procedural: hemisférios, sulcos, cerebelo e tronco |
| `src/graph-core.ts` | Grafo a partir dos links resolvidos, com comunidades por propagação de rótulos |
| `src/layout.ts` | Vagas no córtex por região, depois forças com spatial hash e projeção na anatomia |
| `src/renderer.ts` | Three.js: pontos com shader de brilho, fibras Bézier, pulsos, picking, rótulos |
| `src/view.ts` | ItemView do Obsidian: barra de ferramentas, busca, abrir nota, rebuild incremental |
| `src/settings.ts` | Configurações |

## Por que é leve

- **Poucas chamadas de desenho:** nós, fibras, pulsos e córtex são 4 draw calls no total.
- **Layout finito:** o layout converge e para. Em repouso, com os pulsos desligados, não renderiza nada.
- **Pausa automática:** quando a aba está oculta, o render para. Só com os pulsos ligados, fica limitado a cerca de 30 fps.
- **Repulsão O(n):** usa spatial hash em vez de O(n²). Vaults grandes usam menos iterações.
