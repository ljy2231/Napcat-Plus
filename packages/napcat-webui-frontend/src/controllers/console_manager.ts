import { serverRequest } from '@/utils/request';
import type { ConsoleStatus, GSCoreConfig, GSCoreUpdate } from '@/types/console';

/** serverRequest already supplies /api and the existing WebUI authentication. */
export default class ConsoleManager {
  static async getStatus () {
    const { data } = await serverRequest.get<ServerResponse<ConsoleStatus>>('/Console/status');
    return data.data;
  }

  static async checkUpdate () {
    const { data } = await serverRequest.get<ServerResponse<unknown>>('/Console/update/check');
    return data.data;
  }

  static async getDockerUpdateStatus () {
    const { data } = await serverRequest.get<ServerResponse<unknown>>('/Console/docker-update/status');
    return data.data;
  }

  static async startDockerUpdate () {
    const { data } = await serverRequest.post<ServerResponse<unknown>>('/Console/docker-update/update', {});
    return data.data;
  }

  static async getGSCoreConfig () {
    const { data } = await serverRequest.get<ServerResponse<GSCoreConfig>>('/Console/gscore');
    return data.data;
  }

  static async setGSCoreConfig (config: GSCoreUpdate) {
    const { data } = await serverRequest.post<ServerResponse<GSCoreConfig>>('/Console/gscore', config);
    return data.data;
  }

  static async reconnectGSCore () {
    await serverRequest.post('/Console/gscore/reconnect', {});
  }
}
