# Brain Graph

Plugin do Obsidian que desenha o vault como um cérebro, em 2D ou 3D. É uma alternativa leve ao graph view nativo.

- **Neurônios:** cada nota é um ponto no córtex. As 10 notas mais conectadas sempre mostram o nome.
- **Regiões:** cada comunidade de notas (detectada pelos links) ou cada pasta de primeiro nível vira uma região do córtex. Grupos muito ligados entre si ficam vizinhos.
- **Órfãs:** notas sem links ficam no cerebelo.
- **Fibras:** os links. Com a superfície desligada (padrão), mergulham para o centro como substância branca. Com a superfície ligada, passam por fora em arco.
- **Mapa estável:** as posições ficam salvas, então o cérebro abre sempre igual. Notas novas entram perto das vizinhas sem bagunçar o resto.

## Instalação

1. Baixe o `brain-graph-X.Y.Z.zip` do [release mais recente](https://github.com/HernanJr0/brain-graph/releases/latest).
2. Extraia em `<vault>/.obsidian/plugins/`. O resultado deve ser `.obsidian/plugins/brain-graph/`, com `main.js`, `manifest.json` e `styles.css`.
3. Em *Configurações → Plugins da comunidade*, recarregue a lista e ative **Brain Graph**.
4. Abra pelo ícone 🧠 na barra lateral ou com Ctrl/Cmd+P → "Abrir Brain Graph".

Na primeira abertura, o plugin calcula o layout (leva alguns segundos, conforme o tamanho do vault) e grava `layout.json` na pasta do plugin. As aberturas seguintes já vêm prontas.

Para atualizar, substitua os arquivos e **reinicie o Obsidian**. Desligar e religar o plugin com a versão nova pode falhar ao carregar.

## Uso

- **Navegar:** arrastar orbita (3D) ou move (2D) a câmera, e a roda dá zoom. Clicar numa nota abre a nota.
- **Barra do grafo:** alterna 2D/3D, liga e desliga córtex, superfície, profundidade de campo, brilho e pulsos ambientes, e tem uma busca por nome.
- **Comandos:** "Abrir Brain Graph", "Recalcular layout do cérebro" e "Alternar 2D/3D".

### Configurações

| Opção | Padrão | O que faz |
| --- | --- | --- |
| Modo padrão | 3D | Como o grafo abre |
| Agrupar regiões por | Links | Comunidades por links ou pasta de primeiro nível |
| Mostrar notas órfãs | ligado | Notas sem links no cerebelo |
| Superfície do cérebro | desligado | Superfície escura com as notas por fora, em vez da nuvem de pontos |
| Profundidade de campo | ligado | Desfoca e esmaece o que está atrás do centro |
| Mostrar córtex | ligado | Contorno anatômico: fissuras, sulcos, lobos, cerebelo e medula |
| Brilho dos nós | ligado | Halo em volta das notas |
| Pulsos no hover | ligado | Sinais correm pelos links da nota sob o mouse |
| Pulsos ambientes | ligado (45) | Sinais lentos o tempo todo |
| Tela de descanso | ligado | Depois de cerca de 1,5 s parado: onda de atividade, brilho respirando e a interface some |
| Órbita na tela de descanso | ligado | A câmera gira devagar em repouso (3D) |
| Tamanho dos nós / Rótulos dos hubs | 1 / ligado | Aparência |
| Recalcular layout | — | Distribui tudo de novo do zero |

## Desempenho

O plugin foi feito para rodar a 20 fps ou mais em GPU integrada.

- **Renderização sob demanda:** só redesenha quando algo muda. Para custo zero com o cérebro parado, desligue os **pulsos ambientes** e a **tela de descanso**. Com qualquer um dos dois ligado, o loop roda a cerca de 30 fps.
- **Pausa automática:** o render para quando a aba fica oculta.
- **Layout finito:** o layout converge e para, com repulsão O(n) por spatial hash. O resultado fica em `layout.json`.
- **LOD:** a profundidade de campo reduz o detalhe do que está ao fundo.

## Desenvolvimento

Requer Node.js 22 e npm.

```bash
npm install
npm run dev      # watch → main.js com sourcemap
npm run build    # type-check (tsc) + build minificado
npm run deploy   # build + copia para um vault de teste
```

O `deploy` usa o caminho passado como argumento, ou a variável `BRAIN_GRAPH_VAULT`, ou `~/Documents/BrainGraph-Teste`. Para um caminho com espaço, chame `node dev/deploy.mjs "<vault>"` direto.

### Preview fora do Obsidian

`dev/preview.ts` renderiza o cérebro com um vault falso no navegador:

```bash
npx esbuild dev/preview.ts --bundle --format=iife --outfile=dev/preview.js
python -m http.server 5178   # abra http://localhost:5178/dev/index.html
```

Parâmetros de URL:
- `n`: número de notas (padrão 1500).
- `clusters`: número de grupos.
- `orphans`: fração de notas órfãs.
- `mode=2d`.
- `view=superior|frontal`.
- `cloud`: sem superfície.
- Efeitos para desligar: `nodof`, `noglow`, `noambient`, `noidle`.

### Scripts de medição

Empacote com `npx esbuild dev/<script>.ts --bundle --platform=node --outfile=dev/<script>.js` e rode com `node`:

- `dev/bench.ts`: tempo de grafo e layout com 1,5k, 8k e 20k notas sintéticas.
- `dev/quality.ts [vault]`: num vault real, mede comprimento dos links, reabertura, nota nova e distribuição por lobo.
- `dev/affinity.ts`: verifica se comunidades ligadas entre si ficam vizinhas.

### Estrutura

| Arquivo | Papel |
| --- | --- |
| `src/main.ts` | Plugin: view, comandos, configurações e persistência em `layout.json` |
| `src/view.ts` | ItemView: barra de ferramentas, busca, abrir nota, rebuild incremental |
| `src/graph-core.ts` | Grafo a partir dos links resolvidos, com comunidades por propagação de rótulos |
| `src/layout.ts` | Sementes por afinidade, vagas no córtex por área, forças com spatial hash e projeção na anatomia |
| `src/brain-shape.ts` | Anatomia procedural por SDF: hemisférios, sulcos, cerebelo e medula estilizados |
| `src/renderer.ts` | Three.js: nós, halos, fibras, pulsos, superfície, profundidade de campo, tela de descanso e picking |
| `src/settings.ts` | Configurações |

### Release

Os releases são publicados pelo GitHub Actions (`.github/workflows/release.yml`):

1. Atualize `version` no `manifest.json` e no `package.json` e acrescente a versão em `versions.json`.
2. Faça o commit, crie a tag anotada e envie: `git tag -a v0.1.7 -m "Brain Graph 0.1.7" && git push origin main v0.1.7`.
3. O workflow confere se a tag bate com o `manifest.json`, faz o build e publica `main.js`, `manifest.json`, `styles.css` e `brain-graph-X.Y.Z.zip`.

Para republicar uma tag existente, use *Actions → Release → Run workflow* e informe a tag.

## Licença

[MIT](LICENSE)
