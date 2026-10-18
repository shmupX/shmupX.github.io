// One call from a cloud level record to a Dezaemon 3D 64DD disk image: the
// project of project-write.js laid onto a disk by disk-write.js, as a .ddd
// (the user area, what this repo's reader takes) or an .ndd (the whole disk,
// what an emulator mounts beside the cartridge).
//
// Environment-neutral ESM (Node + browser); the editor calls it with frames
// sliced off a canvas and a donor disk read from a file input,
// scripts/build-ddd.ts with frames decoded by lib/ps2/png.ts.

import { decompress } from "../decompress.js";
import { buildDisk, imageFormat, readProjects } from "./disk-write.js";
import { buildN64ProjectFromLevel } from "./project-write.js";

/** The file a disk is written as: "Dezaemon 3D - <title>.ndd". */
export function dddFileName(title, format = "ndd") {
    const clean = String(title || "game").replace(/[\\/:*?"<>|]+/g, "-").trim() || "game";
    return `Dezaemon 3D - ${clean}.${format === "ddd" ? "ddd" : "ndd"}`;
}

/**
 * The files of a project on a disk, decompressed, as a template for
 * buildN64ProjectFromLevel(): the named project, or the disk's first.
 * @param {Uint8Array} image  a .ddd or .ndd
 * @param {string|null} [name]
 * @returns {{name: string, files: {ext: string, data: Uint8Array}[]} | null}
 */
export function templateFromDisk(image, name = null) {
    const projects = readProjects(image);
    const pick = name ? projects.find((p) => p.name === String(name).toUpperCase()) : projects[0];
    if (!pick) return null;
    return { name: pick.name, files: pick.files.map((f) => ({ ext: f.ext, data: Uint8Array.from(decompress(f.stream)) })) };
}

/**
 * Export a level record + its RGBA frames as a 64DD disk.
 *
 * Options: everything buildN64ProjectFromLevel() takes (`name`, `title1`,
 * `title2`, `framesPerEnemy`) plus
 *   disk      a donor .ddd/.ndd to write the project onto; omitted, a disk
 *             is built from nothing
 *   template  "disk" (the donor's first project's files underlie the new
 *             one; the default when there is a donor), a project name on
 *             the donor, a files list, or null for none
 *   format    "ndd" (default) or "ddd"
 *   systemArea  the 473,280 bytes to put before the user area of an .ndd;
 *             omitted, the donor's, else one built for a type-0 disk
 *
 * Returns {image, format, fileName, name, project, directory, report, warnings}.
 */
export function exportLevelToDdd(level, art, options = {}) {
    const { disk = null, format = "ndd", systemArea, template: templateOption = disk ? "disk" : null, ...projectOptions } = options;
    if (disk !== null && !imageFormat(disk)) throw new Error(`the donor disk is ${disk.length} bytes, neither a .ddd nor an .ndd`);
    let template = null;
    let templateName = null;
    if (templateOption === "disk" || (typeof templateOption === "string" && templateOption !== "")) {
        if (disk === null) throw new Error("a template project needs a donor disk to come from");
        const t = templateFromDisk(disk, templateOption === "disk" ? null : templateOption);
        if (!t) throw new Error(templateOption === "disk" ? "the donor disk has no project to use as a template" : `the donor disk has no project named ${templateOption}`);
        template = t.files;
        templateName = t.name;
    } else if (Array.isArray(templateOption) || templateOption instanceof Map) {
        template = templateOption;
    }
    const project = buildN64ProjectFromLevel(level, art, { ...projectOptions, template });
    const built = buildDisk({ base: disk, projects: [{ name: project.name, files: project.files }], format, systemArea });
    const title = (level && level.name) || project.name;
    return {
        image: built.image,
        format: built.format,
        fileName: dddFileName(title, built.format),
        name: project.name,
        project: project.report,
        directory: built.directory,
        report: { ...built.report, project: project.report, templateProject: templateName, transform: project.report.transform },
        warnings: [...project.warnings, ...built.warnings],
    };
}
