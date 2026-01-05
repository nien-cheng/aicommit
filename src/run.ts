import { $ } from "bun";
import OpenAI from "openai";
import simpleGit from "simple-git";
import { readConfigFile } from "./config";

interface RunOptions {
	verbose?: boolean;
}

function normalizeCommitSuggestions(raw: string): string[] {
	const lines = raw
		.replaceAll("\r\n", "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.filter((line) => !(line === "```" || line.startsWith("```")));

	const fromNumbered: string[] = [];
	for (const line of lines) {
		const match = line.match(/^(\d+)\s*[\.\)]\s*(.+)\s*$/);
		if (!match) continue;
		fromNumbered.push(match[2]);
	}

	const fromBullets: string[] = [];
	if (fromNumbered.length === 0) {
		for (const line of lines) {
			const match = line.match(/^[-*]\s+(.+)\s*$/);
			if (!match) continue;
			fromBullets.push(match[1]);
		}
	}

	const candidates = fromNumbered.length > 0 ? fromNumbered : fromBullets;
	return candidates
		.map((message) => message.replace(/^["'`]+|["'`]+$/g, "").trim())
		.filter((message) => message.length > 0);
}

async function getStagedDiff(target_dir: string) {
	try {
		const git = simpleGit(target_dir);
		const diff = await git.diff(["--cached"]);

		return diff;
	} catch (error) {
		console.error("Error getting git diff:", error);
		throw error; // Re-throw the error after logging it
	}
}

export async function run(options: RunOptions, templateName?: string) {
	const config = await readConfigFile();
	if (options.verbose) {
		console.error("Configuration loaded successfully.");
	}

	let templateFilePath: string;
	if (templateName) {
		if (!Object.prototype.hasOwnProperty.call(config.templates, templateName)) {
			console.error(
				`Error: Template '${templateName}' does not exist in the configuration.`,
			);
			process.exit(1);
		}
		templateFilePath = config.templates[templateName];
		if (options.verbose) {
			console.error(`Using template: ${templateName}`);
		}
	} else {
		templateFilePath = config.templates.default;
		if (options.verbose) {
			console.error("Using default template.");
		}
	}

	const templateFile = Bun.file(templateFilePath);
	if (!(await templateFile.exists())) {
		console.error(
			`Error: The template file '${templateFilePath}' does not exist.`,
		);
		process.exit(1);
	}
	if (options.verbose) {
		console.error(`Template file found: ${templateFilePath}`);
	}

	const template = await templateFile.text();
	if (options.verbose) {
		console.error("Template file read successfully.");
	}

	const target_dir = (await $`pwd`.text()).trim();
	if (options.verbose) {
		console.error(`Target directory: ${target_dir}`);
	}

	if (!config.OPENAI_API_KEY) {
		console.error("OPENAI_API_KEY is not set");
		process.exit(1);
	}

	if (!config.model) {
		console.error("Model is not set");
		process.exit(1);
	}

	const diff = await getStagedDiff(target_dir);
	if (options.verbose) {
		console.error("Git diff retrieved:\n", diff);
	}

	if (diff.trim().length === 0) {
		console.error(`No changes to commit in ${target_dir}`);
		process.exit(1);
	}

	const rendered_template = template.replace("{{diff}}", diff);
	if (options.verbose) {
		console.error("Template rendered with git diff.");
	}

	const oai = new OpenAI({
		apiKey: config.OPENAI_API_KEY,
		baseURL: config.OPENAI_API_BASE,
	});

	try {
		if (options.verbose) {
			console.error("Sending request to OpenAI...");
		}
		const response = await oai.chat.completions.create({
			messages: [
				{
					role: "system",
					content:
						"You are a commit message generator. I will provide you with a git diff, and you should generate 5 different appropriate commit messages using the conventional commit format. Output ONLY the commit messages in a numbered list format like:\n1. first commit message\n2. second commit message\n3. third commit message\n4. fourth commit message\n5. fifth commit message\n\nDo not write any explanations or other words.",
				},
				{
					role: "user",
					content: rendered_template,
				},
			],
			model: config.model,
		});

		if (options.verbose) {
			console.error("Response received from OpenAI.");
			console.error(JSON.stringify(response, null, 2));
		}

		const message = response.choices[0].message;
		const content = message.content;

		if (!content) {
			console.error("Failed to generate commit message");
			process.exit(1);
		}

		const suggestions = normalizeCommitSuggestions(content);
		if (suggestions.length === 0) {
			console.error(
				"Failed to parse commit messages from model output. Re-run with --verbose to inspect the raw response.",
			);
			process.exit(1);
		}

		const out = suggestions.map((s, idx) => `${idx + 1}. ${s}`).join("\n");
		process.stdout.write(out);
	} catch (error) {
		console.error(`Failed to fetch from openai: ${error}`);
		process.exit(1);
	}
}
