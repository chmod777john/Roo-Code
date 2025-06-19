import * as vscode from "vscode"
import { promises as fs } from "fs"
import path from "path"
import OpenAI from "openai"

import { Task } from "../task/Task"
import { ToolUse, AskApproval, HandleError, PushToolResult, RemoveClosingTag } from "../../shared/tools"
import { formatResponse } from "../prompts/responses"
import { ClineSayTool } from "../../shared/ExtensionMessage"
import { getReadablePath } from "../../utils/path"
import { fileExistsAtPath } from "../../utils/fs"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"

// Initialize the OpenAI client with Morph's API endpoint
const openai = new OpenAI({
	apiKey: process.env.MORPH_API_KEY || "your-morph-api-key", // Use environment variable for API key
	baseURL: "https://api.morphllm.com/v1",
})

/**
 * Tool for performing file edits using the Morph API.
 */
export async function morphEditFileTool(
	cline: Task,
	block: ToolUse,
	askApproval: AskApproval,
	handleError: HandleError,
	pushToolResult: PushToolResult,
	removeClosingTag: RemoveClosingTag,
): Promise<void> {
	const relPath: string | undefined = block.params.path
	const codeEdit: string | undefined = block.params.code_edit // Using code_edit as per Morph documentation

	const sharedMessageProps: ClineSayTool = {
		tool: "morphEditFile",
		path: getReadablePath(cline.cwd, removeClosingTag("path", relPath)),
		diff: codeEdit, // Using diff to display the proposed changes in UI
	}

	try {
		if (block.partial) {
			// Update GUI message for partial tool use
			await cline.ask("tool", JSON.stringify(sharedMessageProps), block.partial).catch(() => {})
			return
		}

		// Validate required parameters
		if (!relPath) {
			cline.consecutiveMistakeCount++
			cline.recordToolError("morph_edit_file")
			pushToolResult(await cline.sayAndCreateMissingParamError("morph_edit_file", "path"))
			return
		}

		if (!codeEdit) {
			cline.consecutiveMistakeCount++
			cline.recordToolError("morph_edit_file")
			pushToolResult(await cline.sayAndCreateMissingParamError("morph_edit_file", "code_edit"))
			return
		}

		const accessAllowed = cline.rooIgnoreController?.validateAccess(relPath)

		if (!accessAllowed) {
			await cline.say("rooignore_error", relPath)
			pushToolResult(formatResponse.toolError(formatResponse.rooIgnoreError(relPath)))
			return
		}

		// Check if file is write-protected
		const isWriteProtected = cline.rooProtectedController?.isWriteProtected(relPath) || false

		const absolutePath = path.resolve(cline.cwd, relPath)
		const fileExists = await fileExistsAtPath(absolutePath)

		if (!fileExists) {
			cline.consecutiveMistakeCount++
			cline.recordToolError("morph_edit_file")
			const formattedError = `File does not exist at path: ${absolutePath}\n\n<error_details>\nThe specified file could not be found. Please verify the file path and try again.\n</error_details>`
			await cline.say("error", formattedError)
			pushToolResult(formattedError)
			return
		}

		// Reset consecutive mistakes since all validations passed
		cline.consecutiveMistakeCount = 0

		// Read the original file content
		let originalContent: string
		try {
			originalContent = await fs.readFile(absolutePath, "utf-8")
		} catch (error) {
			cline.consecutiveMistakeCount++
			cline.recordToolError("morph_edit_file")
			const errorMessage = `Error reading file: ${absolutePath}\nFailed to read the file content: ${
				error instanceof Error ? error.message : String(error)
			}\nPlease verify file permissions and try again.`
			const formattedError = formatResponse.toolError(errorMessage)
			await cline.say("error", formattedError)
			pushToolResult(formattedError)
			return
		}

		// Call Morph API to get the updated content
		let updatedContent: string | null | undefined
		try {
			const response = await openai.chat.completions.create({
				model: "morph-v2", // Using morph-v2 as per documentation
				messages: [
					{
						role: "user",
						content: `<code>${originalContent}</code>\n<update>${codeEdit}</update>`,
					},
				],
			})
			updatedContent = response.choices[0].message.content
		} catch (error) {
			cline.consecutiveMistakeCount++
			cline.recordToolError("morph_edit_file")
			const errorMessage = `Error calling Morph API for file: ${absolutePath}\nAPI Error: ${
				error instanceof Error ? error.message : String(error)
			}\nPlease check your API key and network connection.`
			const formattedError = formatResponse.toolError(errorMessage)
			await cline.say("error", formattedError)
			pushToolResult(formattedError)
			return
		}

		if (!updatedContent) {
			cline.consecutiveMistakeCount++
			cline.recordToolError("morph_edit_file")
			const formattedError = `Morph API returned no content for file: ${absolutePath}`
			await cline.say("error", formattedError)
			pushToolResult(formattedError)
			return
		}

		// Show changes in diff view before asking for approval
		cline.diffViewProvider.editType = "modify"
		cline.diffViewProvider.originalContent = originalContent

		// Open diff view with original content first
		if (!cline.diffViewProvider.isEditing) {
			await cline.ask("tool", JSON.stringify(sharedMessageProps), true).catch(() => {})
			await cline.diffViewProvider.open(relPath)
			await cline.diffViewProvider.update(originalContent, false)
			// No need to scroll here, will scroll after updating with new content
		}

		// Update diff view with the content from Morph API
		await cline.diffViewProvider.update(updatedContent, true)
		cline.diffViewProvider.scrollToFirstDiff()

		// Request user approval for changes
		const completeMessage = JSON.stringify({
			...sharedMessageProps,
			diff: formatResponse.createPrettyPatch(relPath, originalContent, updatedContent), // Generate diff for display
			isProtected: isWriteProtected,
		} satisfies ClineSayTool)

		const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

		if (!didApprove) {
			await cline.diffViewProvider.revertChanges()
			pushToolResult("Changes were rejected by the user.")
			await cline.diffViewProvider.reset()
			return
		}

		// Call saveChanges to update the DiffViewProvider properties and write the file
		await cline.diffViewProvider.saveChanges()

		// Track file edit operation
		if (relPath) {
			await cline.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
		}

		cline.didEditFile = true // Used to determine if we should wait for busy terminal to update

		// Get the formatted response message
		const message = await cline.diffViewProvider.pushToolWriteResult(
			cline,
			cline.cwd,
			false, // Always false for editing existing file
		)

		pushToolResult(message)

		// Record successful tool usage and cleanup
		cline.recordToolUsage("morph_edit_file")
		await cline.diffViewProvider.reset()
	} catch (error) {
		handleError("editing file with Morph API", error)
		await cline.diffViewProvider.reset()
	}
}
