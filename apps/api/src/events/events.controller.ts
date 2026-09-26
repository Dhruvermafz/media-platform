import { Controller, MessageEvent, Sse, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, RequestUser } from '../auth/decorators/current-user.decorator';
import { EventsService } from './events.service';

const HEARTBEAT_MS = 25_000; // under typical 30-60s proxy idle timeouts

@ApiTags('events')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Sse()
  @ApiOperation({
    summary: 'Server-Sent Events stream of changes to the caller\'s library and jobs',
    description:
      'Send `Authorization: Bearer <jwt>` (use fetch streaming; the browser EventSource API cannot set headers). ' +
      'Events are hints to refetch, not a source of truth. Event names: `ready`, `ping`, `platform`.',
  })
  stream(@CurrentUser() user: RequestUser): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      subscriber.next({ type: 'ready', data: { ts: new Date().toISOString() } });
      const off = this.events.subscribe(user.userId, (envelope) =>
        subscriber.next({ id: envelope.id, type: 'platform', data: envelope }),
      );
      const heartbeat = setInterval(() => subscriber.next({ type: 'ping', data: {} }), HEARTBEAT_MS);
      // Runs when the client disconnects - without this every closed tab leaks a listener.
      return () => {
        clearInterval(heartbeat);
        off();
      };
    });
  }
}
