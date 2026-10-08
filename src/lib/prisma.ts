import { PrismaPg } from '@prisma/adapter-pg';
import { getConfig } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { getLogger } from './logger.js';

export function createPrismaClient(connectionString: string): PrismaClient {
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    // PRIVACIDADE: avisos e erros do Prisma vêm como evento e passam pelo nosso logger com
    // só o "alvo" (qual operação). A mensagem fica de fora: o Prisma costuma incluir nela os
    // argumentos da consulta, com nome e telefone do cliente.
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  });
  client.$on('warn', (event) => getLogger().warn({ target: event.target }, 'prisma: aviso'));
  client.$on('error', (event) => getLogger().error({ target: event.target }, 'prisma: erro'));
  return client;
}

let instance: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  instance ??= createPrismaClient(getConfig().databaseUrl);
  return instance;
}

/** Fecha as conexões no encerramento do servidor (só se o banco chegou a ser usado). */
export async function disconnectPrisma(): Promise<void> {
  await instance?.$disconnect();
  instance = undefined;
}
