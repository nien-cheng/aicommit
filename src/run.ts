import { $ } from "bun";
import OpenAI from "openai";
import { readConfigFile } from "./config";
import simpleGit from "simple-git";

interface RunOptions {
	verbose?: boolean;
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
		console.debug("Configuration loaded successfully.");
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
			console.debug(`Using template: ${templateName}`);
		}
	} else {
		templateFilePath = config.templates.default;
		if (options.verbose) {
			console.debug("Using default template.");
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
		console.debug(`Template file found: ${templateFilePath}`);
	}

	const template = await templateFile.text();
	if (options.verbose) {
		console.debug("Template file read successfully.");
	}

	const target_dir = (await $`pwd`.text()).trim();
	if (options.verbose) {
		console.debug(`Target directory: ${target_dir}`);
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
		console.debug("Git diff retrieved:\n", diff);
	}

	if (diff.trim().length === 0) {
		console.error(`No changes to commit in ${target_dir}`);
		process.exit(1);
	}

	const rendered_template = template.replace("{{diff}}", diff);
	if (options.verbose) {
		console.debug("Template rendered with git diff.");
	}

	// Show progress to stderr (won't interfere with stdout parsing)
	if (!options.verbose) {
		console.error("Generating commit messages...");
	}

	const oai = new OpenAI({
		apiKey: config.OPENAI_API_KEY,
		baseURL: config.OPENAI_API_BASE,
	});

	try {
		if (options.verbose) {
			console.debug("Sending request to OpenAI...");
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
			console.debug("Response received from OpenAI.");
			console.debug(JSON.stringify(response, null, 2));
		}

		const message = response.choices[0].message;
		const content = message.content || (message as any).reasoning_content;

		if (!content) {
			console.error("Failed to generate commit message");
			process.exit(1);
		}

		if (!options.verbose) {
			console.error("Done!");
		}

		console.log(content.trim());
		if (options.verbose) {
			console.debug("Commit message generated and outputted.");
		}
	} catch (error) {
		console.error(`Failed to fetch from openai: ${error}`);
		process.exit(1);
	}
}
