import {readFileSync} from "node:fs";
import {join} from "node:path";
import {onRequest} from "firebase-functions/v2/https";
import {getFirestore} from "firebase-admin/firestore";
import {
  decodeProfileDiscoveryMarker,
  decodePublicProfile,
  type PublicProfile,
} from "./decoders";
import {
  renderNotFoundDocument,
  renderProfileDocument,
  renderSitemap,
} from "./publicProfileRenderer";

const USERNAME_PATTERN = /^[a-z0-9-]{3,30}$/;

interface StoredDocument {
  id: string;
  value: unknown;
}

export interface PublicWebRepository {
  getProfile(_username: string): Promise<unknown | null>;
  getDiscovery(_username: string): Promise<unknown | null>;
  listDiscoveries(): Promise<StoredDocument[]>;
}

export interface PublicWebRequest {
  method: string;
  path: string;
}

export interface PublicWebResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const firestoreRepository: PublicWebRepository = {
  async getProfile(username) {
    const snapshot = await getFirestore().collection("profiles").doc(username).get();
    return snapshot.exists ? snapshot.data() ?? null : null;
  },
  async getDiscovery(username) {
    const snapshot = await getFirestore().collection("profileDiscovery").doc(username).get();
    return snapshot.exists ? snapshot.data() ?? null : null;
  },
  async listDiscoveries() {
    const snapshot = await getFirestore().collection("profileDiscovery").get();
    return snapshot.docs.map((document) => ({
      id: document.id,
      value: document.data(),
    }));
  },
};

function htmlHeaders(cacheControl: string): Record<string, string> {
  return {
    "Cache-Control": cacheControl,
    "Content-Type": "text/html; charset=utf-8",
  };
}

function profileIsPublic(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    !Array.isArray(value) && "public" in value && value.public === true;
}

async function sitemapProfiles(
  repository: PublicWebRepository,
): Promise<Array<{username: string; updatedAt: Date}>> {
  const discoveries = await repository.listDiscoveries();
  const profiles = await Promise.all(discoveries.map(async (document) => {
    if (!USERNAME_PATTERN.test(document.id)) {
      throw new Error(`invalid profile discovery id ${document.id}`);
    }
    const marker = decodeProfileDiscoveryMarker(document.value);
    const storedProfile = await repository.getProfile(document.id);
    if (storedProfile === null || !profileIsPublic(storedProfile)) return null;
    const profile = decodePublicProfile(document.id, storedProfile);
    if (profile.uid !== marker.uid) return null;
    return {
      username: document.id,
      updatedAt: profile.updatedAt.toDate(),
    };
  }));
  return profiles.filter(
    (profile): profile is {username: string; updatedAt: Date} => profile !== null,
  );
}

async function profileResponse(
  request: PublicWebRequest,
  repository: PublicWebRepository,
  shell: string,
  username: string,
): Promise<PublicWebResponse> {
  const [storedProfile, storedDiscovery] = await Promise.all([
    repository.getProfile(username),
    repository.getDiscovery(username),
  ]);
  if (storedProfile === null || !profileIsPublic(storedProfile)) {
    return {
      status: 404,
      headers: htmlHeaders("no-store"),
      body: request.method === "HEAD" ? "" : renderNotFoundDocument(shell),
    };
  }

  const profile: PublicProfile = decodePublicProfile(username, storedProfile);
  const searchable = storedDiscovery === null
    ? false
    : decodeProfileDiscoveryMarker(storedDiscovery).uid === profile.uid;
  return {
    status: 200,
    headers: htmlHeaders("no-store"),
    body: request.method === "HEAD" ? "" :
      renderProfileDocument(shell, profile, searchable),
  };
}

export async function resolvePublicWebRequest(
  request: PublicWebRequest,
  repository: PublicWebRepository,
  shell: string,
): Promise<PublicWebResponse> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return {
      status: 405,
      headers: {
        Allow: "GET, HEAD",
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: "Method not allowed.\n",
    };
  }

  if (request.path === "/sitemap.xml") {
    const profiles = await sitemapProfiles(repository);
    return {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=300, s-maxage=300",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: request.method === "HEAD" ? "" : renderSitemap(profiles),
    };
  }

  const match = /^\/profiles\/([^/]+)$/.exec(request.path);
  if (match === null || !USERNAME_PATTERN.test(match[1])) {
    return {
      status: 404,
      headers: htmlHeaders("no-store"),
      body: request.method === "HEAD" ? "" : renderNotFoundDocument(shell),
    };
  }
  return profileResponse(request, repository, shell, match[1]);
}

function profileShell(): string {
  return readFileSync(join(__dirname, "../assets/profile-shell.html"), "utf8");
}

export const publicweb = onRequest(
  {
    region: "europe-west1",
    timeoutSeconds: 30,
  },
  async (request, response) => {
    const result = await resolvePublicWebRequest(
      {method: request.method, path: request.path},
      firestoreRepository,
      profileShell(),
    );
    response.status(result.status);
    for (const [name, value] of Object.entries(result.headers)) {
      response.set(name, value);
    }
    response.send(result.body);
  },
);
