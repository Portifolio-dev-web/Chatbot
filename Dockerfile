# syntax=docker/dockerfile:1
#
# Imagem do chatbot, em estágios:
#   deps      -> todas as dependências (inclusive de build) + Prisma Client gerado
#   build     -> compila o TypeScript para dist/
#   prod-deps -> só as dependências de produção
#   runtime   -> imagem final: sem código-fonte TS, sem testes, sem ferramentas de build
#
# Versões FIXADAS: o build de amanhã é igual ao de hoje. Para atualizar, troque aqui
# (Node 24 = LTS ativa).
ARG NODE_IMAGE=node:24.21.0-alpine3.24

FROM ${NODE_IMAGE} AS base
WORKDIR /app
# Telemetria e avisos de atualização desligados: nada sai do container sem necessidade.
ENV CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

FROM base AS deps
COPY package.json package-lock.json .npmrc prisma.config.ts ./
COPY prisma ./prisma
# npm ci instala EXATAMENTE o package-lock (e falha se ele divergir do package.json).
# O postinstall gera o Prisma Client a partir do schema.
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM base AS prod-deps
COPY package.json package-lock.json .npmrc prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

FROM base AS runtime
# HOME=/tmp: o sistema de arquivos do container é só leitura (ver docker-compose.yml); só
# /tmp aceita escrita, e é lá que npm/Prisma guardam qualquer cache.
ENV NODE_ENV=production \
    PORT=3000 \
    HOME=/tmp
# Os arquivos pertencem ao root e o processo roda como "node" (uid 1000): mesmo que alguém
# consiga executar algo pelo app, não consegue alterar o código nem as dependências.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json prisma.config.ts ./
COPY prisma ./prisma
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1
# 1) Migrações pendentes (o Prisma usa trava no banco: dois containers subindo juntos não
#    aplicam a mesma migração duas vezes).
# 2) exec: o node vira o processo principal e recebe o SIGTERM do Docker direto, para
#    terminar o que está fazendo antes de sair.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node --enable-source-maps dist/server.js"]
