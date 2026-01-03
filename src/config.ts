import path from "path";
import os from "os";
import * as p from "@clack/prompts";
import OpenAI from "openai";
import { spawn } from "child_process";
import { template } from "./template";

async function editFile(filePath: string, onExit: () => void) {
	let editor =
		process.env.EDITOR ||
		(await p.select({
			message: "Select an editor",
			options: [
				{
					label: "vim",
					value: "vim",
				},
				{
					label: "nano",
					value: "nano",
				},
				{
					label: "cancel",
					value: "cancel",
				},
			],
		}));

	if (!editor || typeof editor !== "string" || editor === "cancel") {
		return;
	}

	let additionalArgs: string[] = [];
	if (/^(.[/\\])?code(.exe)?(\s+--.+)*/i.test(editor)) {
		editor = "code";
		additionalArgs = ["--wait"];
	}

	const child = spawn(editor, [filePath, ...additionalArgs], {
		stdio: "inherit",
	});

	await new Promise((resolve, reject) => {
		// biome-ignore lint/suspicious/noExplicitAny: unknown types to me
		child.on("exit", async (_e: any, _code: any) => {
			try {
				resolve(await onExit());
			} catch (error) {
				reject(error);
			}
		});
	});
}

function hasOwn<T extends object, K extends PropertyKey>(
	obj: T,
	key: K,
): obj is T & Record<K, unknown> {
	return key in obj && Object.prototype.hasOwnProperty.call(obj, key);
}

export const configPath = path.join(os.homedir(), ".bunnai");

export interface Config {
	OPENAI_API_KEY: string;
	OPENAI_API_BASE?: string;
	model: string;
	templates: Record<string, string>;
}

const DEFAULT_CONFIG: Config = {
	OPENAI_API_KEY: "",
	OPENAI_API_BASE: "https://api.openai.com/v1",
	model: "gpt-4-0125-preview",
	templates: {
		default: path.join(os.homedir(), ".bunnai-template"),
	},
};

export async function readConfigFile(): Promise<Config> {
	const fileExists = await Bun.file(configPath).exists();
	let config = DEFAULT_CONFIG;

	if (fileExists) {
		const configString = await Bun.file(configPath).text();
		const fileConfig = JSON.parse(configString);
		config = {
			...DEFAULT_CONFIG,
			...fileConfig,
		};
	}

	// Environment variables override config file
	if (process.env.OPENAI_API_KEY) {
		config.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
	}
	if (process.env.OPENAI_API_BASE) {
		config.OPENAI_API_BASE = process.env.OPENAI_API_BASE;
	}
	if (process.env.OPENAI_MODEL) {
		config.model = process.env.OPENAI_MODEL;
	}

	return config;
}

function validateKeys(keys: string[]): asserts keys is (keyof Config)[] {
	const configKeys = Object.keys(DEFAULT_CONFIG);

	for (const key of keys) {
		if (!configKeys.includes(key)) {
			throw new Error(`Invalid config property: ${key}`);
		}
	}
}

export async function cleanUpTemplates(config: Config): Promise<Config> {
	for (const templateName in config.templates) {
		const templatePath = config.templates[templateName];
		const fileExists = await Bun.file(templatePath).exists();
		if (!fileExists) {
			delete config.templates[templateName];
		}
	}
	return config;
}

export async function setConfigs(
	keyValues: [key: keyof Config, value: Config[keyof Config]][],
) {
	const config = await readConfigFile();

	validateKeys(keyValues.map(([key]) => key));

	for (const [key, value] of keyValues) {
		// @ts-ignore
		config[key] = value;
	}

	await Bun.write(configPath, JSON.stringify(config));
}

export async function showConfigUI() {
	try {
		const config = await cleanUpTemplates(await readConfigFile());

		const choice = (await p.select({
			message: "set config",
			options: [
				{
					label: "OpenAI API Key",
					value: "OPENAI_API_KEY",
					hint: hasOwn<Config, keyof Config>(config, "OPENAI_API_KEY")
						? `sk-...${config.OPENAI_API_KEY.slice(-3)}`
						: "not set",
				},
				{
					label: "OpenAI API Base URL",
					value: "OPENAI_API_BASE",
					hint: config.OPENAI_API_BASE || "https://api.openai.com/v1",
				},
				{
					label: "Model",
					value: "model",
					hint: config.model,
				},
				{
					label: "Prompt Template",
					value: "template",
					hint: "edit the prompt template",
				},
				{
					label: "Test Configuration",
					value: "test",
					hint: "test API connection",
				},
				{
					label: "Cancel",
					value: "cancel",
					hint: "exit",
				},
			],
		})) as keyof Config | "template" | "test" | "cancel" | symbol;

		if (p.isCancel(choice)) {
			return;
		}

		if (choice === "OPENAI_API_KEY") {
			const apiKey = await p.text({
				message: "OpenAI API Key",
				initialValue: config.OPENAI_API_KEY,
			});

			await setConfigs([["OPENAI_API_KEY", apiKey as string]]);
		} else if (choice === "OPENAI_API_BASE") {
			const apiBase = await p.text({
				message: "OpenAI API Base URL",
				initialValue: config.OPENAI_API_BASE,
			});

			await setConfigs([["OPENAI_API_BASE", apiBase as string]]);
		} else if (choice === "model") {
			const model = await p.text({
				message: "Model (e.g., gpt-4, glm-4, deepseek-chat)",
				initialValue: config.model,
			});

			await setConfigs([["model", model as string]]);
		} else if (choice === "template") {
			const templateChoice = (await p.select({
				message: "Choose a template to edit",
				options: [
					...Object.keys(config.templates).map((name) => ({
						label: name,
						value: name,
					})),
					{ label: "Add new template", value: "add_new" },
					{ label: "Cancel", value: "cancel" },
				],
			})) as string;

			if (templateChoice === "add_new") {
				const newTemplateName = (await p.text({
					message: "New template name",
				})) as string;

				const newTemplatePath = path.join(
					os.homedir(),
					`.bunnai-template-${newTemplateName}`,
				);

				await Bun.write(newTemplatePath, template);
				config.templates[newTemplateName] = newTemplatePath;

				await editFile(newTemplatePath, async () => {
					console.log(`Prompt template '${newTemplateName}' updated`);
					await setConfigs([["templates", config.templates]]);
				});
			} else if (templateChoice !== "cancel") {
				const templatePath = config.templates[templateChoice];

				if (!(await Bun.file(templatePath).exists())) {
					await Bun.write(templatePath, template);
				}

				await editFile(templatePath, () => {
					console.log(`Prompt template '${templateChoice}' updated`);
				});
			}
		} else if (choice === "test") {
			await testConfiguration();
		}

		if (p.isCancel(choice) || choice === "cancel") {
			return;
		}

		showConfigUI();
		// biome-ignore lint/suspicious/noExplicitAny: unknown types to me
	} catch (error: any) {
		console.error(`\n${error.message}\n`);
	}
}

async function getModels() {
	const config = await readConfigFile();
	const apiKey = config.OPENAI_API_KEY;

	if (!apiKey) {
		throw new Error("OPENAI_API_KEY is not set");
	}

	const oai = new OpenAI({
		apiKey,
		baseURL: config.OPENAI_API_BASE,
	});

	const models = await oai.models.list();
	return models.data.map((model) => model.id);
}

async function testConfiguration() {
	const spinner = p.spinner();

	try {
		spinner.start("Testing API configuration...");

		const config = await readConfigFile();

		if (!config.OPENAI_API_KEY) {
			spinner.stop("API Key is not set");
			return;
		}

		const oai = new OpenAI({
			apiKey: config.OPENAI_API_KEY,
			baseURL: config.OPENAI_API_BASE,
		});

		// Test with a simple API call
		const response = await oai.chat.completions.create({
			messages: [
				{
					role: "user",
					content: "Say 'OK' if you can read this",
				},
			],
			model: config.model,
			max_tokens: 10,
		});

		const message = response.choices[0]?.message;
		const content = message?.content || (message as any)?.reasoning_content;

		if (content) {
			spinner.stop(`✓ Configuration test successful!\n  API Base: ${config.OPENAI_API_BASE}\n  Model: ${config.model}\n  Response: ${content.trim()}`);
		} else {
			// Show full response for debugging
			spinner.stop(`✓ API connection successful but unexpected response format:\n${JSON.stringify(response, null, 2)}`);
		}
	} catch (error: any) {
		spinner.stop(`✗ Test failed: ${error.message}`);
	}
}
