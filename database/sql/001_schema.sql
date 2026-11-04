-- Leia+: DDL físico gerado por pg_dump de banco temporário vazio migrado.
-- Autoridade: database/migracoes; inclui domínio, sequências, constraints, índices,
-- sessões e controles técnicos. Sem dados. Aplicar primeiro, em banco vazio.
-- Não contém owners, ACLs, credenciais nem DDL repetido nos arquivos seguintes.
BEGIN;
--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: cargas_demonstracao; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cargas_demonstracao (
    chave character varying(60) NOT NULL,
    data_base date NOT NULL,
    manifesto jsonb NOT NULL,
    criado_em timestamp with time zone NOT NULL
);


--
-- Name: ciclos_leitura; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ciclos_leitura (
    id integer NOT NULL,
    livro_id integer NOT NULL,
    data_inicio date NOT NULL,
    data_fim date NOT NULL,
    criado_em timestamp with time zone NOT NULL,
    atualizado_em timestamp with time zone NOT NULL,
    nome character varying(120) NOT NULL,
    orientacoes character varying(2000),
    situacao character varying(20) DEFAULT 'PLANEJADO'::character varying NOT NULL,
    CONSTRAINT ciclos_leitura_nome_nao_vazio CHECK (((nome)::text ~ '[^[:space:]]'::text)),
    CONSTRAINT ciclos_leitura_periodo_valido CHECK ((data_fim >= data_inicio)),
    CONSTRAINT ciclos_leitura_situacao_valida CHECK (((situacao)::text = ANY ((ARRAY['PLANEJADO'::character varying, 'EM_ANDAMENTO'::character varying, 'CONCLUIDO'::character varying])::text[])))
);


--
-- Name: ciclos_leitura_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ciclos_leitura_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ciclos_leitura_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ciclos_leitura_id_seq OWNED BY public.ciclos_leitura.id;


--
-- Name: encontros; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.encontros (
    id integer NOT NULL,
    ciclo_id integer NOT NULL,
    titulo character varying(120) NOT NULL,
    inicio_em timestamp with time zone NOT NULL,
    local character varying(180) NOT NULL,
    criado_em timestamp with time zone NOT NULL,
    atualizado_em timestamp with time zone NOT NULL,
    descricao character varying(2000),
    situacao character varying(20) DEFAULT 'AGENDADO'::character varying NOT NULL,
    CONSTRAINT encontros_local_nao_vazio CHECK (((local)::text ~ '[^[:space:]]'::text)),
    CONSTRAINT encontros_situacao_valida CHECK (((situacao)::text = ANY ((ARRAY['AGENDADO'::character varying, 'REALIZADO'::character varying, 'CANCELADO'::character varying])::text[]))),
    CONSTRAINT encontros_titulo_nao_vazio CHECK (((titulo)::text ~ '[^[:space:]]'::text))
);


--
-- Name: encontros_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.encontros_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: encontros_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.encontros_id_seq OWNED BY public.encontros.id;


--
-- Name: generos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generos (
    id integer NOT NULL,
    nome character varying(60) NOT NULL,
    criado_em timestamp with time zone NOT NULL,
    atualizado_em timestamp with time zone NOT NULL,
    CONSTRAINT generos_nome_nao_vazio CHECK (((nome)::text ~ '[^[:space:]]'::text))
);


--
-- Name: generos_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.generos_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: generos_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.generos_id_seq OWNED BY public.generos.id;


--
-- Name: generos_semeados; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generos_semeados (
    semeador character varying(255) NOT NULL,
    genero_id integer NOT NULL
);


--
-- Name: inscricoes_encontro; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inscricoes_encontro (
    id integer NOT NULL,
    usuario_id integer NOT NULL,
    encontro_id integer NOT NULL,
    criado_em timestamp with time zone NOT NULL,
    atualizado_em timestamp with time zone NOT NULL
);


--
-- Name: inscricoes_encontro_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.inscricoes_encontro_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: inscricoes_encontro_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.inscricoes_encontro_id_seq OWNED BY public.inscricoes_encontro.id;


--
-- Name: livros; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.livros (
    id integer NOT NULL,
    titulo character varying(160) NOT NULL,
    autor character varying(120) NOT NULL,
    genero_id integer NOT NULL,
    criado_em timestamp with time zone NOT NULL,
    atualizado_em timestamp with time zone NOT NULL,
    total_paginas integer NOT NULL,
    ano_publicacao integer,
    descricao character varying(2000),
    capa_url text,
    CONSTRAINT livros_ano_publicacao_positivo CHECK (((ano_publicacao IS NULL) OR (ano_publicacao > 0))),
    CONSTRAINT livros_autor_nao_vazio CHECK (((autor)::text ~ '[^[:space:]]'::text)),
    CONSTRAINT livros_titulo_nao_vazio CHECK (((titulo)::text ~ '[^[:space:]]'::text)),
    CONSTRAINT livros_total_paginas_positivo CHECK ((total_paginas > 0))
);


--
-- Name: livros_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.livros_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: livros_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.livros_id_seq OWNED BY public.livros.id;


--
-- Name: participacoes_leitura; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.participacoes_leitura (
    id integer NOT NULL,
    usuario_id integer NOT NULL,
    ciclo_id integer NOT NULL,
    criado_em timestamp with time zone NOT NULL,
    atualizado_em timestamp with time zone NOT NULL,
    pagina_atual integer DEFAULT 0 NOT NULL,
    concluida_em timestamp with time zone,
    CONSTRAINT participacoes_leitura_pagina_nao_negativa CHECK ((pagina_atual >= 0))
);


--
-- Name: participacoes_leitura_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.participacoes_leitura_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: participacoes_leitura_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.participacoes_leitura_id_seq OWNED BY public.participacoes_leitura.id;


--
-- Name: sequelize_meta; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sequelize_meta (
    name character varying(255) NOT NULL
);


--
-- Name: sequelize_seeds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sequelize_seeds (
    name character varying(255) NOT NULL
);


--
-- Name: sessoes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessoes (
    sid character varying NOT NULL,
    sess json NOT NULL,
    expire timestamp(6) without time zone NOT NULL
);


--
-- Name: usuarios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usuarios (
    id integer NOT NULL,
    nome character varying(100) NOT NULL,
    email character varying(254) NOT NULL,
    perfil character varying(20) DEFAULT 'LEITOR'::character varying NOT NULL,
    criado_em timestamp with time zone NOT NULL,
    atualizado_em timestamp with time zone NOT NULL,
    senha_hash text NOT NULL,
    situacao character varying(10) DEFAULT 'PENDENTE'::character varying NOT NULL,
    session_version integer DEFAULT 0 NOT NULL,
    CONSTRAINT usuarios_email_normalizado CHECK ((((email)::text = lower(btrim((email)::text))) AND (length(btrim((email)::text)) > 0))),
    CONSTRAINT usuarios_nome_nao_vazio CHECK (((nome)::text ~ '[^[:space:]]'::text)),
    CONSTRAINT usuarios_perfil_valido CHECK (((perfil)::text = ANY ((ARRAY['ADMIN_CLUBE'::character varying, 'LEITOR'::character varying])::text[]))),
    CONSTRAINT usuarios_senha_hash_nao_vazio CHECK ((length(btrim(senha_hash)) > 0)),
    CONSTRAINT usuarios_session_version_nao_negativa CHECK ((session_version >= 0)),
    CONSTRAINT usuarios_situacao_valida CHECK (((situacao)::text = ANY ((ARRAY['PENDENTE'::character varying, 'ATIVO'::character varying, 'INATIVO'::character varying])::text[])))
);


--
-- Name: usuarios_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.usuarios_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: usuarios_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.usuarios_id_seq OWNED BY public.usuarios.id;


--
-- Name: ciclos_leitura id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ciclos_leitura ALTER COLUMN id SET DEFAULT nextval('public.ciclos_leitura_id_seq'::regclass);


--
-- Name: encontros id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encontros ALTER COLUMN id SET DEFAULT nextval('public.encontros_id_seq'::regclass);


--
-- Name: generos id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generos ALTER COLUMN id SET DEFAULT nextval('public.generos_id_seq'::regclass);


--
-- Name: inscricoes_encontro id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inscricoes_encontro ALTER COLUMN id SET DEFAULT nextval('public.inscricoes_encontro_id_seq'::regclass);


--
-- Name: livros id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livros ALTER COLUMN id SET DEFAULT nextval('public.livros_id_seq'::regclass);


--
-- Name: participacoes_leitura id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participacoes_leitura ALTER COLUMN id SET DEFAULT nextval('public.participacoes_leitura_id_seq'::regclass);


--
-- Name: usuarios id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios ALTER COLUMN id SET DEFAULT nextval('public.usuarios_id_seq'::regclass);


--
-- Name: cargas_demonstracao cargas_demonstracao_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cargas_demonstracao
    ADD CONSTRAINT cargas_demonstracao_pkey PRIMARY KEY (chave);


--
-- Name: ciclos_leitura ciclos_leitura_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ciclos_leitura
    ADD CONSTRAINT ciclos_leitura_pkey PRIMARY KEY (id);


--
-- Name: encontros encontros_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encontros
    ADD CONSTRAINT encontros_pkey PRIMARY KEY (id);


--
-- Name: generos generos_nome_unico; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generos
    ADD CONSTRAINT generos_nome_unico UNIQUE (nome);


--
-- Name: generos generos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generos
    ADD CONSTRAINT generos_pkey PRIMARY KEY (id);


--
-- Name: generos_semeados generos_semeados_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generos_semeados
    ADD CONSTRAINT generos_semeados_pkey PRIMARY KEY (semeador, genero_id);


--
-- Name: inscricoes_encontro inscricoes_encontro_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inscricoes_encontro
    ADD CONSTRAINT inscricoes_encontro_pkey PRIMARY KEY (id);


--
-- Name: inscricoes_encontro inscricoes_encontro_usuario_encontro_unico; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inscricoes_encontro
    ADD CONSTRAINT inscricoes_encontro_usuario_encontro_unico UNIQUE (usuario_id, encontro_id);


--
-- Name: livros livros_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livros
    ADD CONSTRAINT livros_pkey PRIMARY KEY (id);


--
-- Name: participacoes_leitura participacoes_leitura_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participacoes_leitura
    ADD CONSTRAINT participacoes_leitura_pkey PRIMARY KEY (id);


--
-- Name: participacoes_leitura participacoes_leitura_usuario_ciclo_unico; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participacoes_leitura
    ADD CONSTRAINT participacoes_leitura_usuario_ciclo_unico UNIQUE (usuario_id, ciclo_id);


--
-- Name: sequelize_meta sequelize_meta_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequelize_meta
    ADD CONSTRAINT sequelize_meta_pkey PRIMARY KEY (name);


--
-- Name: sequelize_seeds sequelize_seeds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequelize_seeds
    ADD CONSTRAINT sequelize_seeds_pkey PRIMARY KEY (name);


--
-- Name: sessoes sessoes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessoes
    ADD CONSTRAINT sessoes_pkey PRIMARY KEY (sid);


--
-- Name: usuarios usuarios_email_unico; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios
    ADD CONSTRAINT usuarios_email_unico UNIQUE (email);


--
-- Name: usuarios usuarios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios
    ADD CONSTRAINT usuarios_pkey PRIMARY KEY (id);


--
-- Name: ciclos_leitura_unico_em_andamento; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ciclos_leitura_unico_em_andamento ON public.ciclos_leitura USING btree ((1)) WHERE ((situacao)::text = 'EM_ANDAMENTO'::text);


--
-- Name: encontros_ciclo_inicio_indice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX encontros_ciclo_inicio_indice ON public.encontros USING btree (ciclo_id, inicio_em);


--
-- Name: encontros_inicio_indice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX encontros_inicio_indice ON public.encontros USING btree (inicio_em);


--
-- Name: sessoes_expire_indice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessoes_expire_indice ON public.sessoes USING btree (expire);


--
-- Name: ciclos_leitura ciclos_leitura_livro_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ciclos_leitura
    ADD CONSTRAINT ciclos_leitura_livro_id_fkey FOREIGN KEY (livro_id) REFERENCES public.livros(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: encontros encontros_ciclo_leitura_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encontros
    ADD CONSTRAINT encontros_ciclo_leitura_id_fkey FOREIGN KEY (ciclo_id) REFERENCES public.ciclos_leitura(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: generos_semeados generos_semeados_genero_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generos_semeados
    ADD CONSTRAINT generos_semeados_genero_id_fkey FOREIGN KEY (genero_id) REFERENCES public.generos(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: inscricoes_encontro inscricoes_encontro_encontro_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inscricoes_encontro
    ADD CONSTRAINT inscricoes_encontro_encontro_id_fkey FOREIGN KEY (encontro_id) REFERENCES public.encontros(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: inscricoes_encontro inscricoes_encontro_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inscricoes_encontro
    ADD CONSTRAINT inscricoes_encontro_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: livros livros_genero_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.livros
    ADD CONSTRAINT livros_genero_id_fkey FOREIGN KEY (genero_id) REFERENCES public.generos(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: participacoes_leitura participacoes_leitura_ciclo_leitura_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participacoes_leitura
    ADD CONSTRAINT participacoes_leitura_ciclo_leitura_id_fkey FOREIGN KEY (ciclo_id) REFERENCES public.ciclos_leitura(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: participacoes_leitura participacoes_leitura_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participacoes_leitura
    ADD CONSTRAINT participacoes_leitura_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--



COMMIT;
